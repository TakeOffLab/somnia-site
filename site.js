import { FaceFeed, freshStats } from "./face-state.js";
const canvas = document.querySelector("[data-somnia-face]");
if (canvas) {
  const primary = {
    idle: [
      "会話を待っています。",
      "新しい会話や、周りの状況が変わるのを待っています。",
    ],
    listening: [
      "話を聞いています。",
      "届いた会話の内容と、話の流れを確認しています。",
    ],
    speaking: [
      "話しています。",
      "会話に返事をしたり、自分から考えを伝えたりしています。",
    ],
    thinking: [
      "考えています。",
      "会話や記憶をもとに、どう答えるか、次に何をするかを考えています。",
    ],
    working: [
      "作業を進めています。",
      "AIエージェントや道具を使い、調べものや作業を進めています。",
    ],
    sleeping: [
      "眠っています。",
      "起きている間の経験を整理し、大切な情報を記憶に残しています。",
    ],
    waking_up: [
      "目を覚ましています。",
      "睡眠を終えて、会話や活動を再開する準備をしています。",
    ],
    unwell: [
      "動作に問題が起きています。",
      "一部の処理がうまく進まず、いつもどおりに動けない状態です。",
    ],
  };
  const moods = {
      calm: "落ち着いている",
      content: "満足そう",
      curious: "興味津々",
      focused: "集中している",
      alert: "注意を向けている",
      anxious: "心配そう",
      weary: "疲れぎみ",
      happy: "うれしそう",
    },
    energies = {
      fresh: "元気",
      normal: "いつもどおり",
      drowsy: "眠そう",
      exhausted: "休息が必要",
    };
  const set = (s, t) => {
    const el = document.querySelector(s);
    if (el && el.textContent !== t) el.textContent = t;
  };
  let renderer = null,
    lastState = null,
    isLive = false;
  const feed = new FaceFeed(
    (state) => {
      lastState = state;
      renderer?.setState(state);
      set("[data-primary-caption]", primary[state.primary][0]);
      set("[data-state-explanation]", primary[state.primary][1]);
      set("[data-mood-caption]", moods[state.mood]);
      set("[data-energy-caption]", energies[state.energy]);
    },
    (live, initial) => {
      isLive = live;
      const label = document.querySelector("[data-live-label]");
      label.dataset.live = String(live);
      label.textContent = live
        ? "LIVE / 本体とつながっています"
        : initial
          ? "状態を確認しています"
          : "更新待ち / 現在の状態を受信できません";
      if (!live && !initial) {
        set("[data-primary-caption]", "現在の状態を確認できません。");
        set(
          "[data-state-explanation]",
          lastState
            ? "顔には、最後に届いた状態を表示しています。現在の様子は、接続が戻ると更新されます。"
            : "Somniaの状態を受信できていません。接続が戻ると、自動で表示を更新します。",
        );
        set("[data-mood-caption]", "—");
        set("[data-energy-caption]", "—");
        if (lastState) renderer?.setState({ ...lastState, effects: [] });
      }
    },
  );
  feed.start();
  import("./face-renderer.js?v=20260913-3")
    .then(async ({ FaceRenderer }) => {
      renderer = new FaceRenderer(
        canvas,
        document.querySelector("[data-somnia-effects]"),
      );
      await renderer.init();
      if (lastState)
        renderer.setState({
          ...lastState,
          effects: isLive ? lastState.effects : [],
        });
      const button = document.querySelector(".motion-toggle");
      button.hidden = false;
      const label = () => {
        button.textContent = renderer.paused
          ? "動きを再開する"
          : "動きを止める";
        button.setAttribute("aria-pressed", String(renderer.paused));
      };
      label();
      button.addEventListener("click", () => {
        renderer.paused = !renderer.paused;
        label();
        renderer.resume();
      });
    })
    .catch(() => {
      set(
        "[data-live-label]",
        isLive
          ? "LIVE / 静止画で表示しています"
          : "現在の顔は静止画で表示しています",
      );
    });
  const refreshStats = async () => {
    try {
      const r = await fetch(
        "https://raw.githubusercontent.com/TakeOffLab/somnia-site/status/status.json",
        { cache: "no-store", signal: AbortSignal.timeout(8000) },
      );
      if (!r.ok) throw new Error();
      const stats = freshStats(await r.json());
      if (!stats) throw new Error();
      set('[data-stat="days-alive"]', stats.days.toLocaleString("ja-JP"));
      set('[data-stat="sleep-cycles"]', stats.sleeps.toLocaleString("ja-JP"));
    } catch {
      set('[data-stat="days-alive"]', "—");
      set('[data-stat="sleep-cycles"]', "—");
    }
  };
  refreshStats();
  const statsTimer = setInterval(refreshStats, 300000);
  window.addEventListener("pagehide", () => {
    feed.stop();
    clearInterval(statsTimer);
    renderer?.stop();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
}
