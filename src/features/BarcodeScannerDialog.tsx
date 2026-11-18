import { useEffect, useRef, useState } from "react";
import { BarcodeFormat, BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
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
 * 解碼提示（v1.88.11）：
 * - POSSIBLE_FORMATS：只找員工證常見的一維條碼＋QR Code，縮小搜尋範圍。
 * - TRY_HARDER：花更多時間逐行掃描，短條碼偏小／偏離中央時才解得出來。
 *
 * 注意：DecodeHintType 來自 @zxing/library，但本專案不把它列為直接依賴
 * （CI 用 pnpm install --frozen-lockfile，此環境無 pnpm 可更新 lockfile），
 * 故以其公開數值建 Map（POSSIBLE_FORMATS = 2、TRY_HARDER = 3，與 Java ZXing 相同）。
 * BarcodeDetector（瀏覽器原生）不採用：iOS Safari 不支援，而使用者主力是
 * iPhone／iPad；單一 ZXing 路徑與 1.88.9 能用的行為一致。
 */
const SCAN_HINTS: Map<any, any> = new Map();
SCAN_HINTS.set(2, [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.ITF,
  BarcodeFormat.CODABAR,
  BarcodeFormat.QR_CODE,
]);
SCAN_HINTS.set(3, true);

/** 相機約束（v1.88.11）：舊版只有 facingMode；7 碼短條碼需要較高解析度與連續對焦。 */
const VIDEO_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: "environment",
    width: { ideal: 1280 },
    height: { ideal: 720 },
    focusMode: "continuous",
  } as MediaTrackConstraints,
};

type ScanStatus = "starting" | "searching" | "long-search";

export function BarcodeScannerDialog({ onDetected, onClose }: BarcodeScannerDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const onDetectedRef = useRef(onDetected);
  const onCloseRef = useRef(onClose);
  const statusRef = useRef<ScanStatus>("starting");
  const longSearchTimerRef = useRef<number | undefined>(undefined);
  const [scanStatus, setScanStatus] = useState<ScanStatus>("starting");
  const [decodeNote, setDecodeNote] = useState("");
  const [error, setError] = useState("");
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
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
    const reader = new BrowserMultiFormatReader(SCAN_HINTS);
    const video = videoRef.current;

    if (!video) return;

    // 每一幀解不到都會回 NotFoundException，代表相機已經在辨識中：
    // 第一次收到回呼就把狀態從「啟動中」切為「辨識中」，不要再靜默無反應。
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

    void reader
      .decodeFromConstraints(VIDEO_CONSTRAINTS, video, (result, decodeError, controls) => {
        controlsRef.current = controls;
        if (disposed || delivered) return;
        if (result) {
          const value = result.getText().trim();
          if (!value) return;
          delivered = true;
          window.clearTimeout(longSearchTimerRef.current);
          controls.stop();
          onDetectedRef.current(value);
          return;
        }
        markSearching();
        if (decodeError && decodeError.name !== "NotFoundException") {
          setDecodeNote("尚未辨識到條碼，請將條碼對準框線、靠近一點。");
        }
      })
      .then((controls) => {
        controlsRef.current = controls;
        if (disposed) {
          controls.stop();
          return;
        }
        // switchTorch 只在裝置支援手電筒時才會出現（ZXing 內部判斷）。
        setTorchSupported(typeof controls.switchTorch === "function");
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(cameraErrorMessage(reason));
      });

    return () => {
      disposed = true;
      window.clearTimeout(longSearchTimerRef.current);
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, []);

  async function toggleTorch() {
    const controls = controlsRef.current;
    if (!controls?.switchTorch) return;
    const next = !torchOn;
    try {
      await controls.switchTorch(next);
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
      setTorchOn(false);
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
        <div className="employee-barcode-video-wrap">
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
                ? decodeNote || "辨識中：請將條碼對準框線、靠近一點，保持穩定"
                : "仍未辨識到條碼：請再靠近一點、確認光線充足，或改用手動輸入職編"}
          </p>
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
          <button type="button" className="button button-outline" onClick={onClose}>
            改用手動輸入／關閉
          </button>
        </footer>
      </section>
    </div>
  );
}
