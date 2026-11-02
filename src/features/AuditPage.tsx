import { useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ShieldCheck,
} from "lucide-react";
import { AUDIT_QUESTIONS as QUESTIONS } from "../data/demo";
import { PageHeading } from "../components/ui";

export function AuditPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answer, setAnswer] = useState<string | null>(null);
  const question = QUESTIONS[questionIndex];
  const progress = Math.round(((questionIndex + 1) / QUESTIONS.length) * 100);
  const next = () => {
    if (!answer) {
      onAction("請先選擇一個展示答案");
      return;
    }
    if (questionIndex === QUESTIONS.length - 1) {
      onAction("展示審查已完成；沒有資料送出或儲存");
      setQuestionIndex(0);
      setAnswer(null);
      return;
    }
    setQuestionIndex((current) => current + 1);
    setAnswer(null);
  };
  return (
    <>
      <PageHeading
        page="audit"
        action={
          <span className="status-pill info">
            <span className="live-dot" />
            進行中展示
          </span>
        }
      />
      <div className="privacy-note">
        <ShieldCheck size={16} />
        <span>
          <b>隱私提醒</b>
          ：正式稽核只記錄病人床號並提示一次；本展示版不開放輸入真實病人資料或床號。
        </span>
      </div>
      <div className="audit-layout">
        <section className="panel audit-main">
          <div className="audit-topline">
            <div>
              <span className="eyebrow">NQ-001 · 給藥安全正確率</span>
              <h2>
                示範內科病房 <span>·</span> 展示床號 8A-12
              </h2>
            </div>
            <div className="audit-counter">
              <b>{String(questionIndex + 1).padStart(2, "0")}</b>
              <span>/ {String(QUESTIONS.length).padStart(2, "0")}</span>
            </div>
          </div>
          <div className="audit-progress">
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="audit-question">
            <span className="question-tag">{question.category}</span>
            <h3>{question.text}</h3>
            <p>{question.hint}</p>
          </div>
          <div className="answer-grid">
            {["是", "否", "不適用"].map((option) => (
              <button
                key={option}
                className={`answer-option${answer === option ? " selected" : ""}`}
                onClick={() => setAnswer(option)}
              >
                <span className="answer-check">
                  {answer === option && <Check size={16} />}
                </span>
                <b>{option}</b>
                <small>
                  {option === "是"
                    ? "符合查核標準"
                    : option === "否"
                      ? "記錄待改善項目"
                      : "本題不適用"}
                </small>
              </button>
            ))}
          </div>
          {answer === "否" && (
            <div className="defect-inline">
              <span className="defect-dot" />
              <span>
                <b>缺失分類展示</b>
                <small>
                  選擇「否」時，正式流程可展開缺失類別、照片標註與即時改善行動。
                </small>
              </span>
              <button
                className="text-button"
                onClick={() => onAction("缺失分類僅展示，不會建立改善紀錄")}
              >
                了解 <ArrowRight size={14} />
              </button>
            </div>
          )}
          <div className="audit-bottom">
            <button
              className="button button-ghost"
              onClick={() => {
                setQuestionIndex(Math.max(0, questionIndex - 1));
                setAnswer(null);
              }}
              disabled={questionIndex === 0}
            >
              <ChevronLeft size={16} />
              上一題
            </button>
            <span>
              <CheckCheck size={15} /> 答案僅保存在本次展示頁面
            </span>
            <button className="button button-primary" onClick={next}>
              {questionIndex === QUESTIONS.length - 1
                ? "完成展示審查"
                : "下一題"}
              <ChevronRight size={16} />
            </button>
          </div>
        </section>
        <aside className="audit-side">
          <section className="panel audit-meta">
            <div className="meta-label">審查資訊</div>
            <InfoRow label="審查月份" value="2026 年 11 月" />
            <InfoRow label="指標版本" value="v2.1" />
            <InfoRow label="閾值" value="≥ 95%" />
            <InfoRow label="排程單位" value="示範內科病房" />
            <InfoRow label="審查員" value="展示審查員 A" hidden={true} />
          </section>
          <section className="panel audit-help">
            <span className="help-icon">
              <CircleHelp size={18} />
            </span>
            <b>審查流程小提醒</b>
            <p>
              每題依查核證據選擇答案。「否」可記錄缺失，完成後由系統內核准流程確認。
            </p>
            <button
              className="text-button"
              onClick={() => onAction("展示版暫不提供正式指引檔案")}
            >
              查看指標指引 <ArrowRight size={14} />
            </button>
          </section>
        </aside>
      </div>
    </>
  );
}

function InfoRow({
  label,
  value,
  hidden = false,
}: {
  label: string;
  value: string;
  hidden?: boolean;
}) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <b>{hidden ? "依權限隱藏" : value}</b>
    </div>
  );
}
