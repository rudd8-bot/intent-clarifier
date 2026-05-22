import { useState } from "react";

// ─── API (Vercel 프록시 경유) ─────────────────────────────────
async function callClaude(system, user) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system,
      messages: [{ role: "user", content: user }]
    })
  });
  const data = await res.json();
  if (!data.content?.[0]?.text) throw new Error("API 오류");
  return data.content[0].text;
}

function safeJson(text) {
  try { return JSON.parse(text.replace(/```json|```/g, "").trim()); }
  catch { return null; }
}

// ─── PROMPTS ────────────────────────────────────────────────────
const ROUND_PROMPT = (num) => `사용자의 불편함/문제 의도를 파악하는 라운드 ${num}이다.

${num === 1
  ? "축: 목적(찾기/이해/결정/전달/만들기/확인) + 감정(빠르게/확실하게/완전히) + 대상(나/팀/고객)"
  : num === 2
  ? "축: 형식(문서/코드/대화/비교표/요약/실행계획) + 수준(개요만/깊게/바로실행) + 공유(혼자/공유)"
  : "축: 타이밍(지금바로/나중에) + 완성도(초안이라도/완성된것) + 크기(작게시작/한번에크게)"}

규칙:
- 각 축마다 2~3개, 총 8~10개 선택지
- 선택지 7자 이내, 축 이름 3자 이내로 짧게
- 사용자 맥락 반영
- JSON만 출력

출력: {"groups": [{"axis": "축이름", "options": ["선택지1", "선택지2"]}, ...]}`;

const REFINEMENT_PROMPT = `특정 축에서 "이게 아닌데"가 2회 반복됐다. 그 축 안을 더 세밀하게 쪼개야 한다.
규칙: 해당 축의 하위 개념 5개로 세분화, 6자 이내, JSON만 출력
출력: {"axis": "축이름", "options": ["세부1","세부2","세부3","세부4","세부5"]}`;

const STUCK_Q_PROMPT = `사용자 의도가 3라운드 후에도 잡히지 않았다.
의도를 좁힐 직접 질문 1개를 만들어라. 20자 이내, "지금 가장 ___?" 형식.
JSON만 출력: {"question": "질문"}`;

const STUCK_ROUND_PROMPT = `사용자가 직접 질문에 답했다. 그 답변으로 좁은 선택지 5개를 만들어라.
7자 이내, JSON만 출력: {"options": ["선택지1","선택지2","선택지3","선택지4","선택지5"]}`;

const RESULT_PROMPT = `지금까지의 선택 데이터로 의도를 분석해라.

신뢰도:
1(뚜렷해): 이게아닌데 없음 + 같은 축 수렴
2(대략): 이게아닌데 1회 or 약간 분산
3(방향은맞는데): 이게아닌데 2회+ or 축 분산
4(못잡음): 패턴 없음

출력:
{"confidence": 1~4, "summary": "2문장 요약", "firstSentence": "AI한테 던질 첫 문장 1개, 구체적으로"}
JSON만 출력.`;

const CONF = {
  1: { label: "뚜렷하게 잡혔어", color: "#6ee7b7", hint: "첫 문장 바로 복사해서 써봐" },
  2: { label: "대략 잡혔어",     color: "#fbbf24", hint: "첫 문장 자연스러우면 맞는 거야" },
  3: { label: "방향은 맞는데 흐려", color: "#f97316", hint: "첫 문장 고쳐가면서 좁혀봐" },
  4: { label: "아직 못 잡았어",  color: "#f87171", hint: "'가장 피하고 싶은 것' 하나만 써서 다시 시작해봐" }
};

export default function App() {
  const [stage, setStage] = useState("input");
  const [userInput, setUserInput] = useState("");
  const [roundNum, setRoundNum] = useState(1);
  const [groups, setGroups] = useState([]);
  const [selected, setSelected] = useState([]);
  const [notThis, setNotThis] = useState(false);
  const [history, setHistory] = useState([]);
  const [axisNotThisMap, setAxisNotThisMap] = useState({});
  const [refinementAxis, setRefinementAxis] = useState(null);
  const [stuckCount, setStuckCount] = useState(0);
  const [stuckQuestion, setStuckQuestion] = useState("");
  const [stuckAnswer, setStuckAnswer] = useState("");
  const [result, setResult] = useState(null);
  const [editedSentence, setEditedSentence] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const buildHistText = (hist) =>
    hist.map(h => `${h.label}: 선택=[${h.selected.join(",")}] 이게아닌데=${h.notThis}`).join("\n");

  const getSelectedAxes = () => {
    const map = {};
    groups.forEach(g => {
      if (g.options.some(o => selected.includes(o))) map[g.axis] = true;
    });
    return Object.keys(map);
  };

  const goResult = async (hist) => {
    const text = await callClaude(RESULT_PROMPT,
      `원본 입력: "${userInput}"\n이력:\n${buildHistText(hist)}`);
    const parsed = safeJson(text);
    if (!parsed?.confidence) throw new Error("파싱 실패");
    setResult(parsed);
    setEditedSentence(parsed.firstSentence);
    setStage("result");
  };

  const goStuck = async (hist) => {
    const next = stuckCount + 1;
    setStuckCount(next);
    if (next >= 2) { setStage("giveup"); return; }
    const text = await callClaude(STUCK_Q_PROMPT,
      `원본 입력: "${userInput}"\n이력:\n${buildHistText(hist)}`);
    const parsed = safeJson(text);
    if (!parsed?.question) throw new Error();
    setStuckQuestion(parsed.question);
    setStuckAnswer("");
    setStage("stuck");
  };

  const startRound1 = async () => {
    if (!userInput.trim()) return;
    setLoading(true); setError("");
    try {
      const text = await callClaude(ROUND_PROMPT(1), `사용자 입력: "${userInput}"`);
      const parsed = safeJson(text);
      if (!parsed?.groups) throw new Error();
      setGroups(parsed.groups);
      setSelected([]); setNotThis(false);
      setRoundNum(1); setStage("round");
    } catch { setError("선택지 생성 실패. 다시 시도해줘."); }
    setLoading(false);
  };

  const handleNext = async () => {
    setLoading(true); setError("");
    const roundData = {
      label: stage === "refinement" ? `세밀화(${refinementAxis})` :
             stage === "stuckRound" ? "막힘라운드" : `R${roundNum}`,
      selected, notThis
    };
    const newHist = [...history, roundData];
    setHistory(newHist);

    let newAxisMap = { ...axisNotThisMap };
    if (notThis) {
      getSelectedAxes().forEach(ax => {
        newAxisMap[ax] = (newAxisMap[ax] || 0) + 1;
      });
      setAxisNotThisMap(newAxisMap);
    }

    const needRefineAxis = Object.entries(newAxisMap).find(([, c]) => c >= 2)?.[0];

    try {
      if (needRefineAxis && stage !== "refinement") {
        const text = await callClaude(REFINEMENT_PROMPT,
          `세밀화 축: "${needRefineAxis}"\n원본: "${userInput}"\n이력:\n${buildHistText(newHist)}`);
        const parsed = safeJson(text);
        if (!parsed?.options) throw new Error();
        setGroups([{ axis: parsed.axis || needRefineAxis, options: parsed.options }]);
        setRefinementAxis(needRefineAxis);
        setSelected([]); setNotThis(false);
        setStage("refinement");
      } else if (stage === "refinement" && notThis) {
        await goStuck(newHist);
      } else if (stage === "stuckRound" || stage === "refinement" || roundNum >= 3) {
        await goResult(newHist);
      } else {
        const next = roundNum + 1;
        const text = await callClaude(ROUND_PROMPT(next),
          `원본: "${userInput}"\n이력:\n${buildHistText(newHist)}`);
        const parsed = safeJson(text);
        if (!parsed?.groups) throw new Error();
        setGroups(parsed.groups);
        setSelected([]); setNotThis(false);
        setRoundNum(next);
        setStage("round");
      }
    } catch { setError("처리 중 오류. 다시 시도해줘."); }
    setLoading(false);
  };

  const handleDone = async () => {
    setLoading(true); setError("");
    const roundData = { label: `R${roundNum}(조기)`, selected, notThis };
    const newHist = [...history, roundData];
    setHistory(newHist);
    try { await goResult(newHist); }
    catch { setError("결과 생성 실패."); }
    setLoading(false);
  };

  const handleStuckAnswer = async () => {
    if (!stuckAnswer.trim()) return;
    setLoading(true); setError("");
    try {
      const text = await callClaude(STUCK_ROUND_PROMPT,
        `원본: "${userInput}"\n질문: "${stuckQuestion}"\n답변: "${stuckAnswer}"`);
      const parsed = safeJson(text);
      if (!parsed?.options) throw new Error();
      setGroups([{ axis: "좁힌 선택지", options: parsed.options }]);
      setSelected([]); setNotThis(false);
      setStage("stuckRound");
    } catch { setError("처리 중 오류."); }
    setLoading(false);
  };

  const toggle = (opt) =>
    setSelected(prev => prev.includes(opt) ? prev.filter(o => o !== opt) : [...prev, opt]);

  const restart = () => {
    setStage("input"); setUserInput(""); setGroups([]); setSelected([]);
    setNotThis(false); setHistory([]); setAxisNotThisMap({});
    setRefinementAxis(null); setStuckCount(0); setStuckQuestion("");
    setStuckAnswer(""); setResult(null); setEditedSentence("");
    setError(""); setRoundNum(1);
  };

  const isRoundStage = ["round", "refinement", "stuckRound"].includes(stage);
  const conf = result ? CONF[result.confidence] : null;
  const stageLabel =
    stage === "refinement" ? `세밀화 · ${refinementAxis}` :
    stage === "stuckRound" ? "마지막 시도" :
    `라운드 ${roundNum} / 3`;
  const nextBtnLabel = loading ? "분석 중..." :
    (stage === "refinement" || stage === "stuckRound" || roundNum >= 3) ? "결과 보기 →" : "다음 →";

  return (
    <div style={{
      minHeight: "100vh", background: "#0c0c12",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      padding: "32px 16px",
      fontFamily: "'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif"
    }}>
      <div style={{ width: "100%", maxWidth: 500 }}>
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#6ee7b7", boxShadow: "0 0 10px #6ee7b7" }} />
            <span style={{ fontSize: 10, color: "#6ee7b7", letterSpacing: 3, textTransform: "uppercase" }}>Intent Clarifier</span>
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#eeeef5", margin: 0 }}>뭘 원하는지 모를 때</h1>
          <p style={{ fontSize: 12, color: "#3a3a50", marginTop: 4, marginBottom: 0 }}>선택으로 의도를 좁혀가는 도구</p>
        </div>

        {stage === "input" && (
          <div>
            <p style={{ fontSize: 13, color: "#555", marginBottom: 10 }}>지금 상황을 편하게 써봐. 장황해도 괜찮아.</p>
            <textarea value={userInput} onChange={e => setUserInput(e.target.value)}
              placeholder="예) 요즘 업무가 너무 많아서 뭐부터 해야할지 모르겠고..." rows={5}
              style={{ width: "100%", padding: "13px 15px", background: "#181824",
                border: "1.5px solid #252535", borderRadius: 10, color: "#eeeef5",
                fontSize: 14, resize: "vertical", outline: "none", boxSizing: "border-box", lineHeight: 1.65 }} />
            {error && <p style={{ color: "#f87171", fontSize: 12, marginTop: 8 }}>{error}</p>}
            <button onClick={startRound1} disabled={loading || !userInput.trim()}
              style={{ marginTop: 12, width: "100%", padding: "13px 0",
                background: loading || !userInput.trim() ? "#181824" : "#6ee7b7",
                color: loading || !userInput.trim() ? "#333" : "#0c0c12",
                border: "none", borderRadius: 9, fontSize: 14, fontWeight: 700,
                cursor: loading || !userInput.trim() ? "not-allowed" : "pointer" }}>
              {loading ? "분석 중..." : "의도 찾기 시작 →"}
            </button>
          </div>
        )}

        {isRoundStage && (
          <div>
            <div style={{ display: "flex", gap: 5, marginBottom: 18 }}>
              {[1,2,3].map(r => (
                <div key={r} style={{ flex: 1, height: 2, borderRadius: 2,
                  background: r <= roundNum ? "#6ee7b7" : "#1e1e30",
                  opacity: r < roundNum ? 0.35 : 1 }} />
              ))}
            </div>
            <div style={{ marginBottom: 18 }}>
              <span style={{ fontSize: 10, color: "#3a3a55", letterSpacing: 2, textTransform: "uppercase" }}>{stageLabel}</span>
              <p style={{ fontSize: 14, color: "#7070a0", marginTop: 5, marginBottom: 0 }}>
                {stage === "refinement" ? `"${refinementAxis}" 안에서 더 정확한 걸 골라봐.` :
                 stage === "stuckRound" ? "이 중에 제일 가까운 걸 골라봐." :
                 roundNum === 1 ? "맞는 방향을 골라봐. 여러 개도 괜찮아." :
                 roundNum === 2 ? "조금 더 좁혀볼게." : "마지막이야. 제일 가까운 걸."}
              </p>
            </div>
            {groups.map((g, gi) => (
              <div key={gi} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, color: "#3a3a55", letterSpacing: 2, textTransform: "uppercase",
                  marginBottom: 7, paddingLeft: 2, borderLeft: "2px solid #252535" }}>{g.axis}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {g.options.map((opt, oi) => {
                    const isSel = selected.includes(opt);
                    return (
                      <label key={oi} style={{ display: "flex", alignItems: "center", gap: 10,
                        padding: "10px 13px",
                        background: isSel ? "#0a2218" : "#14141e",
                        border: `1.5px solid ${isSel ? "#6ee7b7" : "#1e1e30"}`,
                        borderRadius: 7, cursor: "pointer", fontSize: 14,
                        color: isSel ? "#6ee7b7" : "#9090b0", transition: "all 0.12s" }}>
                        <input type="checkbox" checked={isSel} onChange={() => toggle(opt)}
                          style={{ width: 14, height: 14, accentColor: "#6ee7b7", flexShrink: 0 }} />
                        {opt}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
            <label style={{ display: "flex", alignItems: "center", gap: 10,
              padding: "9px 13px", marginTop: 2, marginBottom: 16,
              background: notThis ? "#1a1000" : "#0e0e18",
              border: `1.5px solid ${notThis ? "#fbbf24" : "#181828"}`,
              borderRadius: 7, cursor: "pointer", fontSize: 13,
              color: notThis ? "#fbbf24" : "#3a3a55", transition: "all 0.12s" }}>
              <input type="checkbox" checked={notThis} onChange={() => setNotThis(!notThis)}
                style={{ width: 13, height: 13, accentColor: "#fbbf24", flexShrink: 0 }} />
              이게 아닌데 — 방향이 좀 달라
            </label>
            {error && <p style={{ color: "#f87171", fontSize: 12, marginBottom: 10 }}>{error}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleDone} disabled={loading}
                style={{ flex: 1, padding: "12px 0", background: "transparent", color: "#3a3a55",
                  border: "1.5px solid #1e1e30", borderRadius: 8, fontSize: 12,
                  cursor: loading ? "not-allowed" : "pointer" }}>
                충분해, 결과 볼게
              </button>
              <button onClick={handleNext} disabled={loading}
                style={{ flex: 2, padding: "12px 0",
                  background: loading ? "#181824" : "#6ee7b7",
                  color: loading ? "#333" : "#0c0c12",
                  border: "none", borderRadius: 8, fontSize: 14, fontWeight: 700,
                  cursor: loading ? "not-allowed" : "pointer" }}>
                {nextBtnLabel}
              </button>
            </div>
            <p style={{ textAlign: "center", fontSize: 11, color: "#252535", marginTop: 8 }}>{selected.length}개 선택됨</p>
          </div>
        )}

        {stage === "stuck" && (
          <div>
            <div style={{ background: "#14141e", border: "1px solid #252535", borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
              <p style={{ fontSize: 10, color: "#3a3a55", letterSpacing: 2, textTransform: "uppercase", margin: "0 0 8px 0" }}>직접 질문</p>
              <p style={{ fontSize: 16, color: "#eeeef5", margin: 0, fontWeight: 600 }}>{stuckQuestion}</p>
            </div>
            <textarea value={stuckAnswer} onChange={e => setStuckAnswer(e.target.value)}
              placeholder="짧게 써봐." rows={3}
              style={{ width: "100%", padding: "12px 14px", background: "#14141e",
                border: "1.5px solid #252535", borderRadius: 9, color: "#eeeef5",
                fontSize: 14, resize: "none", outline: "none", boxSizing: "border-box" }} />
            {error && <p style={{ color: "#f87171", fontSize: 12, marginTop: 8 }}>{error}</p>}
            <button onClick={handleStuckAnswer} disabled={loading || !stuckAnswer.trim()}
              style={{ marginTop: 10, width: "100%", padding: "13px 0",
                background: loading || !stuckAnswer.trim() ? "#181824" : "#6ee7b7",
                color: loading || !stuckAnswer.trim() ? "#333" : "#0c0c12",
                border: "none", borderRadius: 9, fontSize: 14, fontWeight: 700,
                cursor: loading || !stuckAnswer.trim() ? "not-allowed" : "pointer" }}>
              {loading ? "분석 중..." : "이걸로 다시 →"}
            </button>
          </div>
        )}

        {stage === "result" && result && conf && (
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 7,
              padding: "6px 13px", borderRadius: 20,
              background: `${conf.color}15`, border: `1px solid ${conf.color}40`, marginBottom: 18 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: conf.color, boxShadow: `0 0 6px ${conf.color}` }} />
              <span style={{ fontSize: 13, color: conf.color, fontWeight: 600 }}>{conf.label}</span>
            </div>
            <div style={{ background: "#14141e", border: "1px solid #252535", borderRadius: 10, padding: "14px 16px", marginBottom: 14 }}>
              <p style={{ fontSize: 10, color: "#3a3a55", letterSpacing: 2, textTransform: "uppercase", margin: "0 0 8px 0" }}>의도 요약</p>
              <p style={{ fontSize: 14, color: "#b0b0cc", lineHeight: 1.75, margin: 0 }}>{result.summary}</p>
            </div>
            <div style={{ marginBottom: 14 }}>
              <p style={{ fontSize: 10, color: "#3a3a55", letterSpacing: 2, textTransform: "uppercase", margin: "0 0 8px 0" }}>
                AI한테 이렇게 던져봐 <span style={{ color: "#252540", letterSpacing: 0, textTransform: "none", fontSize: 11 }}>— 고쳐도 돼</span>
              </p>
              <textarea value={editedSentence} onChange={e => setEditedSentence(e.target.value)} rows={3}
                style={{ width: "100%", padding: "12px 14px", background: "#0a2218",
                  border: `1.5px solid ${conf.color}40`, borderRadius: 9, color: "#6ee7b7",
                  fontSize: 14, resize: "none", outline: "none", boxSizing: "border-box", lineHeight: 1.65 }} />
              <p style={{ fontSize: 12, color: "#3a3a55", marginTop: 6 }}>{conf.hint}</p>
            </div>
            <div style={{ background: "#0e0e18", borderRadius: 9, padding: "12px 14px", marginBottom: 16 }}>
              <p style={{ fontSize: 10, color: "#252540", letterSpacing: 2, textTransform: "uppercase", margin: "0 0 8px 0" }}>선택 이력</p>
              {history.map((h, i) => (
                <div key={i} style={{ fontSize: 12, marginBottom: 5 }}>
                  <span style={{ color: "#3a3a55" }}>{h.label} </span>
                  <span style={{ color: "#6060a0" }}>{h.selected.length > 0 ? h.selected.join(" · ") : "없음"}</span>
                  {h.notThis && <span style={{ color: "#fbbf24" }}> · 이게아닌데</span>}
                </div>
              ))}
            </div>
            <button onClick={restart} style={{ width: "100%", padding: "12px 0",
              background: "transparent", color: "#6ee7b7", border: "1.5px solid #6ee7b7",
              borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              다시 시작하기
            </button>
          </div>
        )}

        {stage === "giveup" && (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <div style={{ fontSize: 36, marginBottom: 20 }}>🤔</div>
            <p style={{ color: "#5050a0", fontSize: 15, lineHeight: 1.9, marginBottom: 28 }}>
              이 도구로는 잡기 어려운 것 같아.<br />
              처음으로 돌아가서<br />
              <span style={{ color: "#fbbf24" }}>"지금 가장 피하고 싶은 것"</span><br />
              딱 하나만 써봐.
            </p>
            <button onClick={restart} style={{ padding: "12px 32px", background: "transparent",
              color: "#3a3a55", border: "1.5px solid #252535", borderRadius: 9, fontSize: 13, cursor: "pointer" }}>
              다시 시작하기
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
