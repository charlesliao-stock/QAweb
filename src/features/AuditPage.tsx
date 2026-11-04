/**
 * 指標審查導覽（v1.14.0 改寫）：審查總覽入口。
 * 先列出指標清單（組別／名稱，可搜尋），點某指標進入
 * ReviewOverviewPage（各單位→各輪次→審查紀錄）。
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Search, ShieldCheck } from "lucide-react";
import { collection, getDocs, limit, query } from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { ReviewOverviewPage } from "./ReviewOverviewPage";

interface IndicatorLite {
  id: string;
  name: string;
  group: string;
}

export function AuditPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const [indicators, setIndicators] = useState<IndicatorLite[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<IndicatorLite | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const db = getFirebaseDb();
        const snap = await getDocs(
          query(collection(db, "indicators"), limit(500)),
        );
        const list: IndicatorLite[] = [];
        snap.docs.forEach((d) => {
          const data = d.data() as Record<string, unknown>;
          const name =
            typeof data.name === "string" && data.name ? data.name : d.id;
          const group =
            typeof data.groupName === "string" && data.groupName
              ? data.groupName
              : typeof data.group === "string" && data.group
                ? data.group
                : "未分類";
          list.push({ id: d.id, name, group });
        });
        list.sort(
          (a, b) =>
            a.group.localeCompare(b.group, "zh-Hant") ||
            a.name.localeCompare(b.name, "zh-Hant"),
        );
        setIndicators(list);
      } catch {
        setIndicators([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return indicators;
    return indicators.filter((item) =>
      `${item.name} ${item.group} ${item.id}`.toLowerCase().includes(q),
    );
  }, [indicators, search]);

  if (selected) {
    return (
      <ReviewOverviewPage
        indicatorId={selected.id}
        indicatorName={selected.name}
        onBack={() => setSelected(null)}
        onAction={onAction}
      />
    );
  }

  return (
    <>
      <PageHeading page="audit" />
      <div className="privacy-note">
        <ShieldCheck size={16} />
        <span>
          <b>隱私提醒</b>
          ：稽核時請勿拍攝病人臉部或可辨識身分之資訊。
        </span>
      </div>
      <section className="panel">
        <SectionTitle
          title="選擇指標"
          note="點選指標進入審查總覽（各單位→各輪次→審查紀錄）"
        />
        <label className="search-box audit-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜尋指標名稱、組別或編號"
            aria-label="搜尋指標"
          />
        </label>
        {loading ? (
          <p className="muted-text" role="status">
            載入中…
          </p>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="沒有符合的指標"
            description="請調整關鍵字，或先到指標管理建立指標。"
          />
        ) : (
          <ul className="audit-indicator-list">
            {filtered.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="audit-indicator-row"
                  onClick={() => setSelected(item)}
                >
                  <span className="audit-indicator-main">
                    <b>{item.name}</b>
                    <small>
                      {item.group}・{item.id}
                    </small>
                  </span>
                  <ChevronRight size={18} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
