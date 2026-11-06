/**
 * 審查題目列表共用元件（v1.24）：
 * - 一個組別一個方框，組別名稱在方框外；未分組題目自成一個方框、不掛組別名稱
 * - 每題一行：題目往左靠、中間是選項、右邊是備註
 * - 審核指引在題目下方，平時隱藏；有指引者題目區可點選展開（▸／▾），
 *   展開寬度與題目＋選項＋備註整行相同；再點選收起
 * 兩種模式：edit（審查執行，可作答＋填備註）／view（檢視結果，唯讀＋顯示備註）
 */
import { useState, type ReactNode } from "react";
import {
  groupQuestionsIntoSections,
  optionLabelsOf,
  type AuditQuestion,
} from "../lib/indicators";
import {
  resolveReviewViewSections,
  type ReviewAnswer,
} from "../lib/reviewRecords";

export type ReviewQuestionListProps =
  | {
      mode: "edit";
      questions: AuditQuestion[];
      showGroups: boolean;
      answers: Record<string, number>;
      commonErrorAnswers: Record<string, string[]>;
      notes: Record<string, string>;
      onAnswer: (qid: string, idx: number) => void;
      onCommonErrors: (qid: string, values: string[]) => void;
      onNote: (qid: string, text: string) => void;
    }
  | {
      mode: "view";
      questions: AuditQuestion[];
      showGroups: boolean;
      answers: ReviewAnswer[];
    };

function QuestionRow({
  rowId,
  num,
  itemText,
  guidance,
  open,
  onToggleGuidance,
  optionsNode,
  noteNode,
  missing,
}: {
  rowId?: string;
  /** 全域題號；0＝不顯示編號 */
  num: number;
  itemText: string;
  guidance: string;
  open: boolean;
  onToggleGuidance: () => void;
  optionsNode: ReactNode;
  noteNode: ReactNode;
  missing?: boolean;
}) {
  const hasGuidance = guidance.trim() !== "";
  const label = `${num > 0 ? `${num}. ` : ""}${itemText}`;
  return (
    <div className="review-qrow" id={rowId}>
      <div className="q-main">
        <div className="q-text">
          {hasGuidance ? (
            <button
              type="button"
              className="q-text-btn"
              onClick={onToggleGuidance}
              aria-expanded={open}
              aria-label={`${label}（指引）`}
            >
              <span className="q-caret" aria-hidden="true">
                {open ? "▾" : "▸"}
              </span>
              <b>{label}</b>
            </button>
          ) : (
            <b>{label}</b>
          )}
          {missing ? (
            <span className="status-pill warning" style={{ marginLeft: 8 }}>
              尚未作答
            </span>
          ) : null}
        </div>
        <div className="q-options">{optionsNode}</div>
        <div className="q-note">{noteNode}</div>
      </div>
      {hasGuidance && open ? (
        <div className="q-guidance">
          <p style={{ whiteSpace: "pre-wrap" }}>{guidance}</p>
        </div>
      ) : null}
    </div>
  );
}

export function ReviewQuestionList(props: ReviewQuestionListProps) {
  /** questionId → 指引是否展開（每題獨立） */
  const [openGuidance, setOpenGuidance] = useState<Record<string, boolean>>({});
  const toggleGuidance = (qid: string) =>
    setOpenGuidance((prev) => ({ ...prev, [qid]: !prev[qid] }));

  if (props.mode === "edit") {
    const {
      questions,
      showGroups,
      answers,
      commonErrorAnswers,
      notes,
      onAnswer,
      onCommonErrors,
      onNote,
    } = props;
    const numById = new Map(questions.map((q, i) => [q.id, i + 1]));
    const sections = groupQuestionsIntoSections(questions, showGroups);
    return (
      <>
        {sections.map((sec) => (
          <div key={sec.groupId ?? "__ungrouped"}>
            {sec.groupName ? (
              <div className="review-group-label">{sec.groupName}</div>
            ) : null}
            <section className="review-group-box">
              {sec.questions.map((q) => {
                const sel = answers[q.id];
                const num = numById.get(q.id) ?? 0;
                return (
                  <QuestionRow
                    key={q.id}
                    rowId={`req-q-${q.id}`}
                    num={num}
                    itemText={q.itemText || `（第 ${num} 題）`}
                    guidance={q.guidance}
                    open={!!openGuidance[q.id]}
                    onToggleGuidance={() => toggleGuidance(q.id)}
                    missing={sel == null}
                    optionsNode={
                      <div className="review-answer-options">
                        <div
                          className="radio-group"
                          role="radiogroup"
                          aria-label={q.itemText}
                        >
                          {optionLabelsOf(q.optionSet).map((label, oi) => (
                            <label
                              key={oi}
                              className={`check-row${sel === oi ? " checked" : ""}`}
                            >
                              <input
                                type="radio"
                                name={`q-${q.id}`}
                                checked={sel === oi}
                                onChange={() => onAnswer(q.id, oi)}
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                        {(q.commonErrors ?? []).length > 0 && (
                          <fieldset className="common-error-fieldset">
                            <legend>常見錯誤（可複選）</legend>
                            <div className="common-error-options">
                              {q.commonErrors.map((error) => {
                                const checked = (
                                  commonErrorAnswers[q.id] ?? []
                                ).includes(error);
                                return (
                                  <label
                                    key={error}
                                    className={checked ? "checked" : ""}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => {
                                        const current =
                                          commonErrorAnswers[q.id] ?? [];
                                        onCommonErrors(
                                          q.id,
                                          checked
                                            ? current.filter(
                                                (item) => item !== error,
                                              )
                                            : [...current, error],
                                        );
                                      }}
                                    />
                                    <span>{error}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </fieldset>
                        )}
                      </div>
                    }
                    noteNode={
                      <input
                        type="text"
                        className="text-input"
                        placeholder="備註（選填）"
                        value={notes[q.id] ?? ""}
                        onChange={(e) => onNote(q.id, e.target.value)}
                        aria-label={`第 ${num} 題備註`}
                      />
                    }
                  />
                );
              })}
            </section>
          </div>
        ))}
      </>
    );
  }

  const { questions, showGroups, answers } = props;
  const sections = resolveReviewViewSections(questions, answers, showGroups);
  return (
    <>
      {sections.map((sec) => (
        <div key={sec.groupId ?? "__ungrouped"}>
          {sec.groupName ? (
            <div className="review-group-label">{sec.groupName}</div>
          ) : null}
          <section className="review-group-box">
            {sec.rows.map((r) => (
              <QuestionRow
                key={r.questionId}
                num={r.num}
                itemText={r.itemText}
                guidance={r.guidance}
                open={!!openGuidance[r.questionId]}
                onToggleGuidance={() => toggleGuidance(r.questionId)}
                optionsNode={
                  <div className="review-answer-options">
                    <span className="q-option-result">{r.optionLabel}</span>
                    {(
                      props.answers.find(
                        (answer) => answer.questionId === r.questionId,
                      )?.commonErrors ?? []
                    ).length > 0 && (
                      <div className="common-error-results">
                        <b>常見錯誤：</b>
                        {props.answers
                          .find((answer) => answer.questionId === r.questionId)
                          ?.commonErrors?.join("、")}
                      </div>
                    )}
                  </div>
                }
                noteNode={<span className="q-note-text">{r.note || "—"}</span>}
              />
            ))}
          </section>
        </div>
      ))}
    </>
  );
}
