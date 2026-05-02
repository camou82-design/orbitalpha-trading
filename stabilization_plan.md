# Implementation Plan: Stabilizing Automated Trading Authority

## Problem
Automated trading was being deactivated involuntarily (OFF) after session expiration, browser events, or server reboots. The system lacked strict enforcement that only explicit operator actions can disable trading.

## Solution
Hardened the `autoTradeEnabled` state management by requiring an explicit `operatorExplicit` flag in the API and enforcing it on the server.

### 1. Server-Side Hardening
- **API Endpoint (`server/src/index.ts`)**:
    - Modified `/api/v1/trade/auto-toggle` to read `operatorExplicit` from the request body.
    - Passes `isOperator: body.operatorExplicit === true` to the trading control engine.
- **Trading Control (`server/src/trade-control.ts`)**:
    - `setAutoTradeEnabled` strictly rejects disable requests (`enabled: false`) if `isOperator` is not true.
    - Rejection is logged with the tag `TRADE_CONTROL_DISABLE_REJECTED_NON_OPERATOR`.
    - Maintained state persistence in `data/runtime/trade-control-state.json`, ensuring state is restored on boot.

### 2. Frontend Hardening
- **Dashboard UI (`dashboard/app/home-page-client.tsx`)**:
    - Updated `onToggleAutoTrade` to include `operatorExplicit: true` in the request body.
    - Verified that no automatic disable requests are sent during `unmount`, `visibilitychange`, or session expiration.

## Verification Results
- **Build**: Both server and dashboard builds completed successfully.
- **Logic**:
    - Server now rejects requests without `operatorExplicit: true`.
    - Manual button click in the UI now correctly includes this flag.
    - Persistence mechanism confirmed to restore last-known state from file.

## Affected Files
- `server/src/index.ts`: Updated API handler.
- `dashboard/app/home-page-client.tsx`: Updated UI toggle logic.
- `server/src/trade-control.ts`: (Verified) State persistence and rejection logging.
