import { z } from "zod";

const idSegment = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "Use URL-safe id segments (letters, digits, ._-)");

/**
 * Tenant 경계. shopping / jj-admin 등 **다른 서비스 라인과 동일 저장소를 써도** 조회 키로 섞지 않는다.
 */
export const companyIdSchema = idSegment.brand<"CompanyId">();

/**
 * 서비스 인스턴스 (예: signal-bot). 플랫폼 서비스 라인 상수와 혼동하지 말 것.
 */
export const serviceIdSchema = idSegment.brand<"ServiceId">();

export const tradingContextSchema = z.object({
  company_id: companyIdSchema,
  service_id: serviceIdSchema,
});

export type CompanyId = z.infer<typeof companyIdSchema>;
export type ServiceId = z.infer<typeof serviceIdSchema>;
export type TradingContext = z.infer<typeof tradingContextSchema>;

export const signalLogEntrySchema = z.object({
  ...tradingContextSchema.shape,
  ts: z.string().min(1),
  kind: z.enum(["signal", "system", "upbit"]),
  message: z.string(),
  payload: z.record(z.unknown()).optional(),
});

export type SignalLogEntry = z.infer<typeof signalLogEntrySchema>;

/** MVP v1 payload for `kind: "signal"` rows (parsed from `payload`). */
export const mvpSignalPayloadV1Schema = z.object({
  v: z.literal(1),
  market: z.string(),
  passed: z.boolean(),
  summary: z.string(),
  reasons: z.array(z.string()),
  filters: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      passed: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
});

export type MvpSignalPayloadV1 = z.infer<typeof mvpSignalPayloadV1Schema>;

const filterRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
});

/** MVP v2 — 저장 필드: signal_type, signal_reason, filter_pass, filter_fail_reason */
export const mvpSignalPayloadV2Schema = z.object({
  v: z.literal(2),
  market: z.string(),
  signal_type: z.string(),
  signal_reason: z.string(),
  filter_pass: z.boolean(),
  filter_fail_reason: z.string().nullable(),
  filters: z.array(filterRowSchema),
  /** 현재 프로세스의 signal monitor 인스턴스 (중복 실행 구분) */
  monitor_instance_id: z.string().uuid().optional(),
  /** 거래량 A/B (선택 — 구 로그 호환) */
  volume_ratio: z.number().optional(),
  volume_threshold_main: z.number().optional(),
  /** 보조 비교 후보: 0.95 / 0.75 */
  volume_threshold_alt: z
    .object({
      "095": z.number(),
      "075": z.number(),
    })
    .optional(),
  would_pass_at_095: z.boolean().optional(),
  would_pass_at_075: z.boolean().optional(),
  /** 패턴 보조 — 메인 `pullback_reclaim` 완화 기준 충족 */
  pullback_relaxed_pass: z.boolean().optional(),
  /** 눌림만 완화 시 전체 통과 여부 */
  would_pass_with_pullback_relaxed: z.boolean().optional(),
  /** 급증 후 종가 유지 — 보조 A/B (메인 실판정 불변) */
  vol_close_relaxed_a_pass: z.boolean().optional(),
  vol_close_relaxed_b_pass: z.boolean().optional(),
  would_pass_with_vol_close_relaxed_a: z.boolean().optional(),
  would_pass_with_vol_close_relaxed_b: z.boolean().optional(),
  /** 박스 돌파 보조 A/B — 고가 ≥ 저항 99.7% / 99.4% (메인 99.8%) */
  breakout_relaxed_a_pass: z.boolean().optional(),
  breakout_relaxed_b_pass: z.boolean().optional(),
  would_pass_with_breakout_relaxed_a: z.boolean().optional(),
  would_pass_with_breakout_relaxed_b: z.boolean().optional(),
  pair_pass_breakout_b_and_pullback_relaxed: z.boolean().optional(),
  pair_pass_breakout_b_and_vol_close_a: z.boolean().optional(),
});

export type MvpSignalPayloadV2 = z.infer<typeof mvpSignalPayloadV2Schema>;
