import { useEffect, useRef, useState } from "react";
import { BarcodeFormat, BrowserCodeReader, BrowserMultiFormatReader } from "@zxing/browser";
import { Camera, X, Zap, ZapOff } from "lucide-react";

type BarcodeScannerDialogProps = {
  onDetected: (value: string) => void;
  onClose: () => void;
};

function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "相機權限未開啟。請在瀏覽器設定允許使用相機後，再重新掃描。";
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "找不到可用的相機，請改用手動輸入職編。";
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return "相機目前無法啟動，請關閉其他使用相機的程式後重試。";
    }
  }
  const message = error instanceof Error ? error.message : "";
  return message ? `無法啟動相機：${message}` : "無法啟動相機，請改用手動輸入職編。";
}

/**
 * 解碼提示（v1.88.12）：
 * - POSSIBLE_FORMATS：員工證是一維條碼（實測 CODE_128），另列常見一維＋QR／
 *   DataMatrix 等全部格式，不再排除 CODE_93、RSS_14 等（v1.88.11 的排除清單
 *   是潛在風險）。
 * - TRY_HARDER：只在深掃階段開（見下），一開始就開會把迴圈拖慢 3–9 倍。
 *
 * 注意：DecodeHintType 來自 @zxing/library，但本專案不把它列為直接依賴
 * （CI 用 pnpm install --frozen-lockfile，此環境無 pnpm 可更新 lockfile），
 * 故以其公開數值建 Map（POSSIBLE_FORMATS = 2、TRY_HARDER = 3，與 Java ZXing 相同）。
 * BarcodeDetector（瀏覽器原生）不採用：iOS Safari 不支援，而使用者主力是
 * iPhone／iPad；維持單一 ZXing 路徑。
 */
const ONE_D_FORMATS: BarcodeFormat[] = [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.ITF,
  BarcodeFormat.CODABAR,
  BarcodeFormat.RSS_14,
  BarcodeFormat.RSS_EXPANDED,
];
const ALL_FORMATS: BarcodeFormat[] = [
  ...ONE_D_FORMATS,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.AZTEC,
  BarcodeFormat.PDF_417,
  BarcodeFormat.MAXICODE,
  BarcodeFormat.MICRO_QR_CODE,
];

function makeHints(deep: boolean): Map<number, unknown> {
  const hints = new Map<number, unknown>();
  hints.set(2, deep ? ALL_FORMATS : ONE_D_FORMATS);
  if (deep) hints.set(3, true);
  return hints;
}

/** 框線在畫面上的位置（與 CSS .employee-barcode-frame 的 inset 一致）。 */
const FRAME_INSET_X = 0.12;
const FRAME_INSET_Y = 0.2;
/** 小角度糾偏：實拍照條碼傾斜約 1°，ZXing 本身不做小角度旋轉重試。 */
const SKEW_ANGLES_DEG = [0, 1, -1, 2, -2];
/** 快掃 3 秒無果才進深掃（TRY_HARDER）。 */
const DEEP_SCAN_AFTER_MS = 3000;

type Rect = { x: number; y: number; w: number; h: number };

/**
 * 把畫面框線換算成影片原始座標。
 * video 以 object-fit: cover 填滿 4:3 容器，直立串流時上下會被裁掉，
 * 須先還原 cover 的縮放與偏移，否則裁出來的位置與框線對不上。
 */
function frameRectInVideo(video: HTMLVideoElement, wrap: HTMLElement): Rect | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const box = wrap.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const scale = Math.max(box.width / vw, box.height / vh);
  const contentW = vw * scale;
  const contentH = vh * scale;
  const offsetX = (box.width - contentW) / 2;
  const offsetY = (box.height - contentH) / 2;
  const fx = box.width * FRAME_INSET_X;
  const fy = box.height * FRAME_INSET_Y;
  const fw = box.width * (1 - FRAME_INSET_X * 2);
  const fh = box.height * (1 - FRAME_INSET_Y * 2);
  const x = (fx - offsetX) / scale;
  const y = (fy - offsetY) / scale;
  const w = fw / scale;
  const h = fh / scale;
  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    w: Math.min(vw - Math.max(0, x), w),
    h: Math.min(vh - Math.max(0, y), h),
  };
}

function expandRect(rect: Rect, vw: number, vh: number, factor: number): Rect {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const w = Math.min(vw, rect.w * factor);
  const h = Math.min(vh, rect.h * factor);
  return {
    x: Math.max(0, Math.min(vw - w, cx - w / 2)),
    y: Math.max(0, Math.min(vh - h, cy - h / 2)),
    w,
    h,
  };
}

function drawVideoCrop(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  rect: Rect,
  angleDeg: number,
): HTMLCanvasElement {
  const w = Math.max(2, Math.round(rect.w));
  const h = Math.max(2, Math.round(rect.h));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  if (angleDeg === 0) return canvas;
  const rotated = document.createElement("canvas");
  rotated.width = w;
  rotated.height = h;
  const rctx = rotated.getContext("2d");
  if (!rctx) return canvas;
  rctx.translate(w / 2, h / 2);
  rctx.rotate((angleDeg * Math.PI) / 180);
  rctx.drawImage(canvas, -w / 2, -h / 2);
  return rotated;
}

type ScanStatus = "starting" | "searching" | "long-search";

export function BarcodeScannerDialog({ onDetected, onClose }: BarcodeScannerDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const onDetectedRef = useRef(onDetected);
  const onCloseRef = useRef(onClose);
  const statusRef = useRef<ScanStatus>("starting");
  const longSearchTimerRef = useRef<number | undefined>(undefined);
  const [scanStatus, setScanStatus] = useState<ScanStatus>("starting");
  const [error, setError] = useState("");
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoNote, setPhotoNote] = useState("");
  onDetectedRef.current = onDetected;
  onCloseRef.current = onClose;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    let disposed = false;
    let delivered = false;
    let timer: number | undefined;
    const reader = new BrowserMultiFormatReader(makeHints(false));
    const video = videoRef.current;
    const wrap = wrapRef.current;
    if (!video || !wrap) return;

    const markSearching = () => {
      if (disposed || delivered || statusRef.current !== "starting") return;
      statusRef.current = "searching";
      setScanStatus("searching");
      longSearchTimerRef.current = window.setTimeout(() => {
        if (!disposed && !delivered) {
          statusRef.current = "long-search";
          setScanStatus("long-search");
        }
      }, 6000);
    };

    const stopStream = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      trackRef.current = null;
    };

    const deliver = (value: string) => {
      const text = value.trim();
      if (!text || delivered) return;
      delivered = true;
      window.clearTimeout(longSearchTimerRef.current);
      window.clearTimeout(timer);
      stopStream();
      onDetectedRef.current(text);
    };

    const cropCanvas = document.createElement("canvas");
    let attempt = 0;
    let deep = false;
    const startedAt = Date.now();

    const tryDecodeCanvas = (canvas: HTMLCanvasElement): string | null => {
      try {
        const result = reader.decodeFromCanvas(canvas);
        const text = result.getText().trim();
        return text || null;
      } catch {
        return null;
      }
    };

    const loop = () => {
      if (disposed || delivered) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        markSearching();
        if (!deep && Date.now() - startedAt > DEEP_SCAN_AFTER_MS) {
          deep = true;
          reader.setHints(makeHints(true));
        }
        const frame = frameRectInVideo(video, wrap);
        if (frame && frame.w > 40 && frame.h > 20) {
          // 輪流試兩種裁切 × 五個小角度：每幀只解一次，迴圈保持輕快，
          // 完整一輪約十次嘗試即可覆蓋全部組合。
          const rect =
            attempt % 2 === 0
              ? frame
              : expandRect(frame, video.videoWidth, video.videoHeight, 1.3);
          const angle =
            SKEW_ANGLES_DEG[Math.floor(attempt / 2) % SKEW_ANGLES_DEG.length];
          attempt += 1;
          const canvas = drawVideoCrop(cropCanvas, video, rect, angle);
          const found = tryDecodeCanvas(canvas);
          if (found) {
            deliver(found);
            return;
          }
        }
      }
      timer = window.setTimeout(loop, deep ? 300 : 120);
    };

    const start = async () => {
      try {
        // 直立友善：直立手機要直向串流，不要硬要 1280×720 橫向
        // （橫向串流會讓條碼在擷取幀裡被轉 90 度）。
        const portrait = window.innerHeight >= window.innerWidth;
        const constraints: MediaStreamConstraints = {
          audio: false,
          video: {
            facingMode: "environment",
            width: { ideal: portrait ? 720 : 1280 },
            height: { ideal: portrait ? 1280 : 720 },
            focusMode: "continuous",
          } as MediaTrackConstraints,
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        trackRef.current = track ?? null;
        video.srcObject = stream;
        await video.play();
        if (disposed) return;
        // 只寫開發者日誌：確認實機串流方向（直／橫）與實際解析度。
        console.info(
          "[barcode] stream",
          `${video.videoWidth}x${video.videoHeight}`,
          track?.getSettings(),
        );
        setTorchSupported(
          track ? BrowserCodeReader.mediaStreamIsTorchCompatibleTrack(track) : false,
        );
        loop();
      } catch (reason: unknown) {
        if (!disposed) setError(cameraErrorMessage(reason));
      }
    };

    void start();

    return () => {
      disposed = true;
      window.clearTimeout(longSearchTimerRef.current);
      window.clearTimeout(timer);
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleTorch() {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await BrowserCodeReader.mediaStreamSetTorch(track, next);
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
      setTorchOn(false);
    }
  }

  /** 拍照辨識備援：拍一張全解析度靜照，框線裁切 × 小角度全試一輪。 */
  async function capturePhoto() {
    const video = videoRef.current;
    const wrap = wrapRef.current;
    if (photoBusy || !video || !wrap || video.videoWidth === 0) return;
    setPhotoBusy(true);
    setPhotoNote("拍照辨識中，請稍候…");
    try {
      const deepReader = new BrowserMultiFormatReader(makeHints(true));
      const frame = frameRectInVideo(video, wrap);
      const crops: Rect[] = [];
      if (frame && frame.w > 40 && frame.h > 20) {
        crops.push(frame);
        crops.push(expandRect(frame, video.videoWidth, video.videoHeight, 1.3));
      }
      crops.push({ x: 0, y: 0, w: video.videoWidth, h: video.videoHeight });
      const angles = [-3, -2, -1, 0, 1, 2, 3];
      const scratch = document.createElement("canvas");
      for (const rect of crops) {
        for (const angle of angles) {
          const canvas = drawVideoCrop(scratch, video, rect, angle);
          let found: string | null = null;
          try {
            const result = deepReader.decodeFromCanvas(canvas);
            found = result.getText().trim() || null;
          } catch {
            found = null;
          }
          if (found) {
            setPhotoBusy(false);
            setPhotoNote("");
            const stream = streamRef.current;
            stream?.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
            trackRef.current = null;
            onDetectedRef.current(found);
            return;
          }
          // 讓畫面有機會更新「辨識中」狀態，不要整輪卡住 UI。
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }
      setPhotoNote("照片仍無法辨識，請再靠近一點重拍，或改用手動輸入職編。");
    } catch {
      setPhotoNote("拍照失敗，請改用手動輸入職編。");
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <div
      className="reviewer-modal-backdrop employee-barcode-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="reviewer-modal employee-barcode-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="employee-barcode-title"
      >
        <header className="reviewer-modal-head">
          <div>
            <h2 id="employee-barcode-title">掃描受審人員職編</h2>
            <p>將職編條碼或 QR Code 放入取景框，辨識後會自動選取受審人員。</p>
          </div>
          <button
            type="button"
            className="button button-ghost"
            aria-label="關閉掃描器"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="employee-barcode-video-wrap" ref={wrapRef}>
          <video ref={videoRef} autoPlay muted playsInline aria-label="條碼掃描相機預覽" />
          <span className="employee-barcode-frame" aria-hidden="true" />
        </div>
        {error ? (
          <p className="employee-barcode-error" role="alert">{error}</p>
        ) : (
          <p className="employee-barcode-hint" aria-live="polite">
            <Camera size={15} />{" "}
            {scanStatus === "starting"
              ? "相機啟動中，請將條碼放在框線內"
              : scanStatus === "searching"
                ? "辨識中：請把條碼靠近到填滿框線，保持穩定"
                : "仍未辨識到條碼：請再靠近一點、確認光線充足，或按下方拍照辨識"}
          </p>
        )}
        {photoNote && (
          <p className="employee-barcode-hint" aria-live="polite">{photoNote}</p>
        )}
        <footer className="employee-barcode-actions">
          {torchSupported && (
            <button
              type="button"
              className="button button-outline"
              onClick={() => void toggleTorch()}
              aria-pressed={torchOn}
            >
              {torchOn ? <ZapOff size={17} /> : <Zap size={17} />}
              {torchOn ? "關閉手電筒" : "開啟手電筒"}
            </button>
          )}
          <button
            type="button"
            className="button button-outline"
            onClick={() => void capturePhoto()}
            disabled={photoBusy || Boolean(error)}
          >
            <Camera size={17} />
            {photoBusy ? "辨識中…" : "拍照辨識"}
          </button>
          <button type="button" className="button button-outline" onClick={onClose}>
            改用手動輸入／關閉
          </button>
        </footer>
      </section>
    </div>
  );
}
