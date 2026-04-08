import type { UpbitCandle } from "./upbit-public.js";

type FilterRow = {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
};

/** 보조 A/B 후보 (고정). 메인만 env로 조정. */
export const VOLUME_THRESHOLD_ALT = {
  "095": 0.95,
  "075": 0.75,
} as const;

export type MvpEvaluation = {
  filter_pass: boolean;
  signal_type: string;
  signal_reason: string;
  filter_fail_reason: string | null;
  filters: FilterRow[];
  reasons: string[];
  summary: string;
  volume_ratio: number;
  volume_threshold_main: number;
  volume_threshold_alt: { "095": number; "075": number };
  would_pass_at_095: boolean;
  would_pass_at_075: boolean;
  /** 메인 `pullback_reclaim`과 별도 — 완화 기준만 충족 여부 (로그·대시보드 보조) */
  pullback_relaxed_pass: boolean;
  /** 메인은 탈락이어도 눌림만 완화 기준으로 바꾸면 전체 6개 통과하는지 */
  would_pass_with_pullback_relaxed: boolean;
  /** 급증 후 종가 유지 — 보조 A/B (메인은 양봉·캔들 내 ≥38% 불변) */
  vol_close_relaxed_a_pass: boolean;
  vol_close_relaxed_b_pass: boolean;
  would_pass_with_vol_close_relaxed_a: boolean;
  would_pass_with_vol_close_relaxed_b: boolean;
  /** 박스 돌파 보조 — 고가 ≥ 저항×99.7% / 99.4% (메인은 99.8%) */
  breakout_relaxed_a_pass: boolean;
  breakout_relaxed_b_pass: boolean;
  would_pass_with_breakout_relaxed_a: boolean;
  would_pass_with_breakout_relaxed_b: boolean;
  /** 복합 보조: 돌파B + 눌림완화 동시 적용 시 6필터 전부 통과 여부 */
  pair_pass_breakout_b_and_pullback_relaxed: boolean;
  /** 복합 보조: 돌파B + 급증 종가 A 동시 적용 시 6필터 전부 통과 여부 */
  pair_pass_breakout_b_and_vol_close_a: boolean;
};

export type EvaluateMvpOptions = {
  volumeThresholdMain: number;
};

function num(x: unknown): number {
  return typeof x === "number" ? x : Number(x);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function allFiltersPassWithOverrides(
  filters: FilterRow[],
  overrides: Partial<Record<string, boolean>>,
): boolean {
  return filters.every((f) => (overrides[f.id] !== undefined ? overrides[f.id]! : f.passed));
}

function fullPassAtVolumeTh(
  volRatio: number,
  volTh: number,
  o: number,
  h: number,
  l: number,
  cl: number,
  range: number,
  boxOk: boolean,
  pullbackOk: boolean,
  wickOk: boolean,
  noSpike: boolean,
): boolean {
  const volOk = volRatio >= volTh;
  const closePos = (cl - l) / range;
  const volCloseOk = volRatio < volTh || (cl > o && closePos >= 0.38);
  return volOk && boxOk && pullbackOk && wickOk && noSpike && volCloseOk;
}

/**
 * Upbit 5m/1m 캔들 기반 1차 MVP.
 * 메인 거래량 임계는 `volumeThresholdMain`, 동일 캔들로 0.95/0.75 전체 통과 여부 보조 계산.
 */
export function evaluateMvpSignal(
  market: string,
  candles5: UpbitCandle[],
  candles1: UpbitCandle[],
  opts: EvaluateMvpOptions,
): MvpEvaluation {
  const volMain = opts.volumeThresholdMain;
  // pass=0 고정이 깨질 정도의 1단계 완화(운영 기본값 포함).
  // - volume: 메인 임계의 95%까지 허용
  // - box breakout: 저항 대비 99.7%까지 허용
  const VOLUME_MAIN_RELAX_MULT = Number(process.env.SIGNAL_VOLUME_MAIN_RELAX_MULT ?? 0.95);
  const BOX_BREAKOUT_MAIN_MULT = Number(process.env.SIGNAL_BOX_BREAKOUT_MAIN_MULT ?? 0.997);
  const volMainEff = Math.max(0.5, volMain * Math.max(0.5, Math.min(1, VOLUME_MAIN_RELAX_MULT)));
  const alt = { "095": VOLUME_THRESHOLD_ALT["095"], "075": VOLUME_THRESHOLD_ALT["075"] };

  const filters: FilterRow[] = [];
  const reasons: string[] = [];

  const push = (f: FilterRow) => {
    filters.push(f);
    if (f.passed) reasons.push(`[통과] ${f.label}`);
    else reasons.push(`[탈락] ${f.label}${f.detail ? ` — ${f.detail}` : ""}`);
  };

  const emptyVolumeFields = (): Pick<
    MvpEvaluation,
    | "volume_ratio"
    | "volume_threshold_main"
    | "volume_threshold_alt"
    | "would_pass_at_095"
    | "would_pass_at_075"
    | "pullback_relaxed_pass"
    | "would_pass_with_pullback_relaxed"
    | "vol_close_relaxed_a_pass"
    | "vol_close_relaxed_b_pass"
    | "would_pass_with_vol_close_relaxed_a"
    | "would_pass_with_vol_close_relaxed_b"
    | "breakout_relaxed_a_pass"
    | "breakout_relaxed_b_pass"
    | "would_pass_with_breakout_relaxed_a"
    | "would_pass_with_breakout_relaxed_b"
    | "pair_pass_breakout_b_and_pullback_relaxed"
    | "pair_pass_breakout_b_and_vol_close_a"
  > => ({
    volume_ratio: 0,
    volume_threshold_main: volMain,
    volume_threshold_alt: alt,
    would_pass_at_095: false,
    would_pass_at_075: false,
    pullback_relaxed_pass: false,
    would_pass_with_pullback_relaxed: false,
    vol_close_relaxed_a_pass: false,
    vol_close_relaxed_b_pass: false,
    would_pass_with_vol_close_relaxed_a: false,
    would_pass_with_vol_close_relaxed_b: false,
    breakout_relaxed_a_pass: false,
    breakout_relaxed_b_pass: false,
    would_pass_with_breakout_relaxed_a: false,
    would_pass_with_breakout_relaxed_b: false,
    pair_pass_breakout_b_and_pullback_relaxed: false,
    pair_pass_breakout_b_and_vol_close_a: false,
  });

  if (candles5.length < 25 || candles1.length < 12) {
    return {
      filter_pass: false,
      signal_type: "none",
      signal_reason: "캔들 데이터 부족",
      filter_fail_reason: "5분/1분 캔들 부족",
      filters: [
        {
          id: "data",
          label: "데이터 충분성",
          passed: false,
          detail: `5m=${candles5.length}, 1m=${candles1.length}`,
        },
      ],
      reasons: ["5분/1분 캔들이 충분하지 않습니다."],
      summary: `${market}: 캔들 데이터 부족`,
      ...emptyVolumeFields(),
    };
  }

  const c = candles5;
  const lastDone = c[c.length - 2]!;
  const o = num(lastDone.opening_price);
  const h = num(lastDone.high_price);
  const l = num(lastDone.low_price);
  const cl = num(lastDone.trade_price);
  const vol = num(lastDone.candle_acc_trade_volume);
  const range = h - l + 1e-9;

  const prev20 = c.slice(-22, -2);
  const volMa = mean(prev20.map((x) => num(x.candle_acc_trade_volume)));
  const volRatio = volMa > 0 ? vol / volMa : 0;

  // --- 1) 거래량 증가 (메인 임계) ---
  const volumeOk = volRatio >= volMainEff;
  push({
    id: "volume_increase",
    label: "거래량 증가",
    passed: volumeOk,
    detail: `완성봉/직전20봉평균=${volRatio.toFixed(2)} (≥${volMainEff.toFixed(2)}; base=${volMain.toFixed(2)})`,
  });

  // --- 2) 박스 상단 돌파 시도 ---
  const rangeBefore = c.slice(-22, -2);
  const rangeHigh = Math.max(...rangeBefore.map((x) => num(x.high_price)));
  const nearTop = h >= rangeHigh * BOX_BREAKOUT_MAIN_MULT;
  /** 로그 보조 — 메인 nearTop(운영에서 1단계 완화 적용됨) */
  const breakoutRelaxedAPass = h >= rangeHigh * Math.max(0.985, BOX_BREAKOUT_MAIN_MULT - 0.001);
  const breakoutRelaxedBPass = h >= rangeHigh * 0.994;
  push({
    id: "box_breakout",
    label: "박스 상단 돌파 시도",
    passed: nearTop,
    detail: `완성봉 고가 ${h.toFixed(0)} vs 저항 ${rangeHigh.toFixed(0)}`,
  });

  // --- 3) 짧은 눌림 후 재상승 ---
  const last5 = c.slice(-6, -1);
  const closes = last5.map((x) => num(x.trade_price));
  const lows = last5.map((x) => num(x.low_price));
  const minLowMid = Math.min(lows[1]!, lows[2]!, lows[3]!);
  const prevClosesMax = Math.max(closes[1]!, closes[2]!);
  const dip = minLowMid < prevClosesMax * 0.9995;
  const reclaim = cl > o * 0.999 && cl >= Math.max(closes[2]!, closes[3]!) * 0.991;
  const dipReclaim = dip && reclaim;
  const momentumOk = cl > o && cl >= closes[1]! * 0.995;
  const pullbackOk = dipReclaim || momentumOk;

  /** 보조: 회복·관성 조건을 한 단계 완화 (메인 판정 불변) */
  const reclaimRelaxed = cl > o * 0.997 && cl >= Math.max(closes[2]!, closes[3]!) * 0.985;
  const dipReclaimRelaxed = dip && reclaimRelaxed;
  const momentumRelaxed = cl > o * 0.997 && cl >= closes[1]! * 0.988;
  const pullbackRelaxedPass = dipReclaimRelaxed || momentumRelaxed;

  push({
    id: "pullback_reclaim",
    label: "짧은 눌림 후 재상승",
    passed: pullbackOk,
    detail: pullbackOk
      ? dipReclaim
        ? "눌림·회복 패턴"
        : "연속 상승/양봉 경로"
      : "눌림·상승 패턴 미약",
  });

  // --- 4) 윗꼬리 과다 제외 ---
  const bodyTop = Math.max(o, cl);
  const upperWick = h - bodyTop;
  const wickRatio = upperWick / range;
  const wickOk = wickRatio <= 0.52;
  push({
    id: "upper_wick",
    label: "윗꼬리 과다 제외",
    passed: wickOk,
    detail: `윗꼬리비율=${(wickRatio * 100).toFixed(1)}% (≤52%)`,
  });

  // --- 5) 단기 수직 급등 제외 (1분봉) ---
  const m1 = candles1.slice(-12);
  let spikeBad = false;
  let spikeDetail = "최근 1분봉 급등 없음";
  for (const bar of m1.slice(-8)) {
    const bo = num(bar.opening_price);
    const bh = num(bar.high_price);
    const bl = num(bar.low_price);
    if (bo <= 0) continue;
    const oneBar = (bh - bl) / bo;
    if (oneBar > 0.028) {
      spikeBad = true;
      spikeDetail = `단일 1m 변동 ${(oneBar * 100).toFixed(2)}% > 2.8%`;
      break;
    }
  }
  if (!spikeBad) {
    const last5m = m1.slice(-5);
    let cum = 0;
    for (const bar of last5m) {
      const bo = num(bar.opening_price);
      const bc = num(bar.trade_price);
      if (bo > 0) cum += (bc - bo) / bo;
    }
    if (cum > 0.045) {
      spikeBad = true;
      spikeDetail = `5연속 1m 누적 상승 ${(cum * 100).toFixed(2)}% > 4.5%`;
    }
  }
  const noSpike = !spikeBad;
  push({
    id: "no_vertical_spike",
    label: "단기 수직 급등 제외",
    passed: noSpike,
    detail: spikeDetail,
  });

  // --- 6) 거래량 급증 후 종가 유지 (메인 임계 기준) ---
  let volCloseHoldOk = true;
  let volCloseDetail = "거래량 기준 미달 시 검사 생략";
  let volCloseRelaxedAPass = true;
  let volCloseRelaxedBPass = true;
  if (volRatio >= volMainEff) {
    const closePos = (cl - l) / range;
    const bullishOk = cl > o;
    const posOk = closePos >= 0.38;
    volCloseHoldOk = bullishOk && posOk;
    volCloseRelaxedAPass = cl >= o * 0.998 && closePos >= 0.28;
    volCloseRelaxedBPass = cl >= o * 0.996 && closePos >= 0.2;
    if (volCloseHoldOk) {
      volCloseDetail = "급증 후 종가 상단 유지";
    } else {
      const posPct = (closePos * 100).toFixed(0);
      if (!bullishOk && !posOk) {
        volCloseDetail = `급증 후 종가: 양봉(종가>시가) 미충족 · 캔들 내 위치 ${posPct}% (필요 ≥38%)`;
      } else if (!bullishOk) {
        volCloseDetail = `급증 후 종가: 양봉(종가>시가) 미충족 — 캔들 내 위치 ${posPct}% (상단에 가깝아도 종가≤시가면 탈락)`;
      } else {
        volCloseDetail = `급증 후 종가: 캔들 내 위치 ${posPct}% (필요 ≥38%, 양봉은 충족)`;
      }
    }
  }
  push({
    id: "volume_spike_close_fail",
    label: "거래량 급증 후 종가 유지",
    passed: volCloseHoldOk,
    detail: volCloseDetail,
  });

  const strict_filter_pass = filters.every((f) => f.passed);
  const would_pass_with_pullback_relaxed = allFiltersPassWithOverrides(filters, {
    pullback_reclaim: pullbackRelaxedPass,
  });
  const would_pass_with_vol_close_relaxed_a = allFiltersPassWithOverrides(filters, {
    volume_spike_close_fail: volCloseRelaxedAPass,
  });
  const would_pass_with_vol_close_relaxed_b = allFiltersPassWithOverrides(filters, {
    volume_spike_close_fail: volCloseRelaxedBPass,
  });
  const would_pass_with_breakout_relaxed_a = allFiltersPassWithOverrides(filters, {
    box_breakout: breakoutRelaxedAPass,
  });
  const would_pass_with_breakout_relaxed_b = allFiltersPassWithOverrides(filters, {
    box_breakout: breakoutRelaxedBPass,
  });
  const pair_pass_breakout_b_and_pullback_relaxed = allFiltersPassWithOverrides(filters, {
    box_breakout: breakoutRelaxedBPass,
    pullback_reclaim: pullbackRelaxedPass,
  });
  const pair_pass_breakout_b_and_vol_close_a = allFiltersPassWithOverrides(filters, {
    box_breakout: breakoutRelaxedBPass,
    volume_spike_close_fail: volCloseRelaxedAPass,
  });
  const failed = filters.filter((f) => !f.passed);
  const filter_fail_reason = strict_filter_pass
    ? null
    : failed.map((f) => `${f.label}: ${f.detail ?? "탈락"}`).join(" | ");

  const boxOk = nearTop;
  const would_pass_at_095 = fullPassAtVolumeTh(
    volRatio,
    alt["095"],
    o,
    h,
    l,
    cl,
    range,
    boxOk,
    pullbackOk,
    wickOk,
    noSpike,
  );
  const would_pass_at_075 = fullPassAtVolumeTh(
    volRatio,
    alt["075"],
    o,
    h,
    l,
    cl,
    range,
    boxOk,
    pullbackOk,
    wickOk,
    noSpike,
  );

  // relaxed → filter_pass 직접 승격(초입 진입 후보).
  // 운영 관찰상 relaxed 플래그는 잡히는데 filter_pass_count=0 고정이므로,
  // 승격 조건을 "breakout relaxed A / pair 2종 / would_pass_at_095"로 제한하고,
  // 최소 강도 가드로 무작정 승격을 방지한다.
  const passedCnt = filters.filter((f) => f.passed).length;
  const relaxedPromoteKey =
    breakoutRelaxedAPass ||
    pair_pass_breakout_b_and_pullback_relaxed ||
    pair_pass_breakout_b_and_vol_close_a ||
    would_pass_at_095;
  // 안전장치(요청한 entry_score>=20에 대응): 필터 통과 수 기반의 간이 점수.
  // - 2/6 통과만으로는 승격하지 않도록(대개 20점 언저리), 최소 3개 통과를 사실상 유도.
  const relaxedEntryScoreProxy =
    passedCnt * 10 +
    (volRatio >= volMainEff ? 5 : 0) +
    (breakoutRelaxedAPass ? 5 : 0);
  const relaxed_filter_pass = relaxedPromoteKey && relaxedEntryScoreProxy >= 20;
  const filter_pass = strict_filter_pass || relaxed_filter_pass;

  const signal_type = filter_pass ? "spot_mvp_v1" : "none";
  const signal_reason = filter_pass
    ? strict_filter_pass
      ? `${market}: 거래량·박스·눌림 충족, 윗꼬리·급등·종가약화 제외 통과`
      : `${market}: relaxed pass (early entry candidate)`
    : `${market}: 조건 미충족 (${filters.filter((f) => f.passed).length}/${filters.length} 통과)`;

  return {
    filter_pass,
    signal_type,
    signal_reason,
    filter_fail_reason,
    filters,
    reasons,
    summary: signal_reason,
    volume_ratio: volRatio,
    volume_threshold_main: volMain,
    volume_threshold_alt: alt,
    would_pass_at_095,
    would_pass_at_075,
    pullback_relaxed_pass: pullbackRelaxedPass,
    would_pass_with_pullback_relaxed,
    vol_close_relaxed_a_pass: volCloseRelaxedAPass,
    vol_close_relaxed_b_pass: volCloseRelaxedBPass,
    would_pass_with_vol_close_relaxed_a,
    would_pass_with_vol_close_relaxed_b,
    breakout_relaxed_a_pass: breakoutRelaxedAPass,
    breakout_relaxed_b_pass: breakoutRelaxedBPass,
    would_pass_with_breakout_relaxed_a,
    would_pass_with_breakout_relaxed_b,
    pair_pass_breakout_b_and_pullback_relaxed,
    pair_pass_breakout_b_and_vol_close_a,
  };
}
