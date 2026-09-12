import { FaceFeed, freshStats } from "./face-state.js";
const canvas = document.querySelector("[data-somnia-face]");
if (canvas) {
  const primary = {
    idle: [
      "静かに、過ごしています。",
      "会話や周りの変化を受けとめながら、次の時間を過ごしています。",
    ],
    listening: [
      "耳を傾けています。",
      "届いた言葉と、その場の流れを受けとめています。",
    ],
    speaking: [
      "言葉を、届けています。",
      "場を読んで考えたことを、言葉にしています。",
    ],
    thinking: [
      "考えを、めぐらせています。",
      "いまの状況と記憶をつなぎ、次にどうするかを考えています。",
    ],
    working: [
      "用事に、取り組んでいます。",
      "道具や作業を担当するエージェントと関わりながら、用事を進めています。",
    ],
    sleeping: [
      "いまは、おやすみ中。",
      "起きている間の出来事や記憶を、整理する時間です。",
    ],
    waking_up: [
      "ゆっくり、目を覚ましています。",
      "眠りのあと、また続きを始めるところです。",
    ],
    unwell: [
      "少し、調子を整えています。",
      "本体から、普段とは違う動作状態が届いています。",
    ],
  };
  const moods = {
      calm: "穏やか",
      content: "満ち足りた",
      curious: "興味津々",
      focused: "集中",
      alert: "注意深い",
      anxious: "気がかり",
      weary: "お疲れ",
      happy: "うれしそう",
    },
    energies = {
      fresh: "元気",
      normal: "いつもどおり",
      drowsy: "眠たげ",
      exhausted: "休みたい頃",
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
        set("[data-primary-caption]", "また、つながるまで。");
        set(
          "[data-state-explanation]",
          lastState
            ? "顔には、最後に届いた状態を表示しています。現在の様子は、接続が戻ると更新されます。"
            : "接続が戻ると、いまの表情がここに届きます。",
        );
        set("[data-mood-caption]", "—");
        set("[data-energy-caption]", "—");
        if (lastState) renderer?.setState({ ...lastState, effects: [] });
      }
    },
  );
  feed.start();
  import("./face-renderer.js")
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
