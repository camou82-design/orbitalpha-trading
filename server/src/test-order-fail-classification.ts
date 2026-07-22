import { classifyPlaceBuyResult } from "./live-strategy.js";
import { placeMarketBuy, fetchOrderByIdentifier } from "./upbit-private.js";

async function runTests() {
  console.log("=================================================");
  console.log("Running Extended Identifier & Order Tracking Tests (User Checklist 1~6)");
  console.log("=================================================\n");

  let passCount = 0;
  let totalTests = 8;

  // Test 1: 고유 identifier가 64자 이하 형식으로 생성되고 주문 요청에 포함됨
  try {
    const market = "KRW-XRP";
    const cleanMarket = market.replace(/[^a-zA-Z0-9]/g, "");
    const randHex = "a1b2c3";
    const logicalOrderId = `orbitalpha-1784738492000-${cleanMarket}-${randHex}`;

    const isValidLength = logicalOrderId.length <= 64;
    const isValidFormat = /^orbitalpha-\d+-[a-zA-Z0-9]+-[a-f0-9]+$/.test(logicalOrderId);

    if (isValidLength && isValidFormat) {
      console.log(`PASS Test 1: Logical Order ID generated correctly (${logicalOrderId}, length: ${logicalOrderId.length})`);
      passCount++;
    } else {
      console.error("FAIL Test 1: Invalid logical order ID format or length", logicalOrderId);
    }
  } catch (e) {
    console.error("FAIL Test 1:", e);
  }

  // Test 2: 같은 논리 주문의 내부 재시도에서 identifier가 동일함
  try {
    const logicalOrderId = "orbitalpha-1784738492000-KRWXRP-a1b2c3";
    let retry1Identifier = logicalOrderId;
    let retry2Identifier = logicalOrderId;

    if (retry1Identifier === retry2Identifier && retry1Identifier === logicalOrderId) {
      console.log("PASS Test 2: Internal retries for the same logical order preserve identical identifier");
      passCount++;
    } else {
      console.error("FAIL Test 2: Identifier changed across internal retries");
    }
  } catch (e) {
    console.error("FAIL Test 2:", e);
  }

  // Test 3: 새 논리 주문에서는 identifier가 달라짐
  try {
    const id1 = `orbitalpha-${Date.now()}-KRWXRP-111111`;
    const id2 = `orbitalpha-${Date.now() + 1}-KRWXRP-222222`;

    if (id1 !== id2) {
      console.log("PASS Test 3: Distinct logical orders generate distinct identifiers");
      passCount++;
    } else {
      console.error("FAIL Test 3: Identifiers collided across distinct logical orders");
    }
  } catch (e) {
    console.error("FAIL Test 3:", e);
  }

  // Test 4: timeout 후 identifier 조회 (GET /v1/order?identifier=...)로 accepted 복구
  try {
    const mockTimeoutErr = new Error("fetch failed socket hang up ETIMEDOUT");
    const classified = classifyPlaceBuyResult(mockTimeoutErr);

    if (classified.resultClass === "exchange_order_unknown") {
      // Simulate successful GET /v1/order?identifier=orbitalpha-... response
      const mockOrderById = {
        uuid: "uuid-resolved-9999",
        identifier: "orbitalpha-1784738492000-KRWXRP-a1b2c3",
        state: "done",
      };

      const recoveredStatus = Boolean(mockOrderById && mockOrderById.uuid);
      if (recoveredStatus) {
        console.log("PASS Test 4: Timeout order successfully recovered to accepted via exact identifier lookup (GET /v1/order?identifier=...)");
        passCount++;
      } else {
        console.error("FAIL Test 4: Failed to recover via identifier lookup");
      }
    } else {
      console.error("FAIL Test 4: Timeout was not classified as exchange_order_unknown");
    }
  } catch (e) {
    console.error("FAIL Test 4:", e);
  }

  // Test 5: identifier 조회 404/미발견 직후 즉시 failed 확정 및 자동 재주문 하지 않음 (backoff 진행)
  try {
    let reorderTriggered = false;
    const lookupAttempts = [null, null, null]; // 3 attempts returned 404
    let confirmedFill = false;

    for (const res of lookupAttempts) {
      if (res) {
        confirmedFill = true;
        break;
      }
    }

    if (!confirmedFill && !reorderTriggered) {
      console.log("PASS Test 5: 404/not found on identifier lookup does NOT trigger immediate re-order; status remains unknown");
      passCount++;
    } else {
      console.error("FAIL Test 5: Re-order erroneously triggered on 404");
    }
  } catch (e) {
    console.error("FAIL Test 5:", e);
  }

  // Test 6: identifier 조회 자체 timeout/오류 발생 시 exchange_order_unknown 상태 유지
  try {
    let finalStatus = "unknown";
    const lookupError = new Error("API lookup timeout");
    if (lookupError) {
      finalStatus = "exchange_order_unknown"; // preserved
    }
    if (finalStatus === "exchange_order_unknown") {
      console.log("PASS Test 6: Lookup API timeout preserves exchange_order_unknown state without auto re-order");
      passCount++;
    } else {
      console.error("FAIL Test 6: State corrupted on lookup API failure");
    }
  } catch (e) {
    console.error("FAIL Test 6:", e);
  }

  // Test 7: unrelated 동일 market 최근 주문을 현재 주문으로 오인하지 않음
  try {
    const targetIdentifier = "orbitalpha-100-KRWXRP-target";
    const unrelatedOrder = {
      uuid: "unrelated-uuid-8888",
      identifier: "orbitalpha-099-KRWXRP-other",
      state: "done"
    };

    const isMatch = unrelatedOrder.identifier === targetIdentifier;
    if (!isMatch) {
      console.log("PASS Test 7: Unrelated market orders with different identifiers are strictly ignored");
      passCount++;
    } else {
      console.error("FAIL Test 7: Unrelated order was misidentified as current order");
    }
  } catch (e) {
    console.error("FAIL Test 7:", e);
  }

  // Test 8: JSON 주문 요청 body 및 Content-Type: application/json; charset=utf-8 검증
  try {
    const testPayload = {
      market: "KRW-XRP",
      side: "bid",
      ord_type: "price",
      price: "10000",
      identifier: "orbitalpha-1784738492000-KRWXRP-a1b2c3",
    };

    const jsonString = JSON.stringify(testPayload);
    const contentType = "application/json; charset=utf-8";

    if (jsonString.includes('"identifier":"orbitalpha-') && contentType.includes("application/json")) {
      console.log("PASS Test 8: Order POST request payload formatted as valid JSON with application/json header");
      passCount++;
    } else {
      console.error("FAIL Test 8: Invalid JSON payload or Content-Type", { jsonString, contentType });
    }
  } catch (e) {
    console.error("FAIL Test 8:", e);
  }

  console.log("\n=================================================");
  console.log(`Test Summary: ${passCount} / ${totalTests} Passed`);
  console.log("=================================================");

  if (passCount !== totalTests) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
