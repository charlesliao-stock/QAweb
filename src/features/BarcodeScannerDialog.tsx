import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { Camera, X } from "lucide-react";

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

export function BarcodeScannerDialog({ onDetected, onClose }: BarcodeScannerDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const onDetectedRef = useRef(onDetected);
  const onCloseRef = useRef(onClose);
  const [error, setError] = useState("");
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
    const reader = new BrowserMultiFormatReader();
    const video = videoRef.current;

    if (!video) return;

    void reader
      .decodeFromVideoDevice(undefined, video, (result, decodeError, controls) => {
        controlsRef.current = controls;
        if (disposed || delivered) return;
        if (result) {
          const value = result.getText().trim();
          if (!value) return;
          delivered = true;
          controls.stop();
          onDetectedRef.current(value);
          return;
        }
        // NotFoundException is expected while the camera is searching each frame.
        if (decodeError && decodeError.name !== "NotFoundException") {
          setError("尚未辨識到條碼，請將條碼放入取景框並保持穩定。");
        }
      })
      .then((controls) => {
        controlsRef.current = controls;
        if (disposed) controls.stop();
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(cameraErrorMessage(reason));
      });

    return () => {
      disposed = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, []);

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
            <p>將職編條碼或 QR Code 放入取景框，辨識後會帶入職編搜尋。</p>
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
            <Camera size={15} /> 相機啟動中，請將條碼放在框線內
          </p>
        )}
        <footer className="employee-barcode-actions">
          <button type="button" className="button button-outline" onClick={onClose}>
            改用手動輸入／關閉
          </button>
        </footer>
      </section>
    </div>
  );
}
