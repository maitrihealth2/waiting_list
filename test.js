const assert = require("assert");

const BASE_URL = process.env.TEST_URL || "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_API_KEY || "affyne_sec_9a7e2b1c4d8f03126e5a4b7c";

async function runTests() {
  console.log(`\n🧪 Running Waitlist Server Verification Tests against ${BASE_URL}\n`);

  // Test 1: Health check
  console.log("▶ [Test 1] Health Check (/health)...");
  const healthRes = await fetch(`${BASE_URL}/health`);
  assert.strictEqual(healthRes.status, 200, "Health check should return 200");
  const healthData = await healthRes.json();
  assert.strictEqual(healthData.ok, true, "Health status should be ok: true");
  assert.strictEqual(healthData.status, "healthy");
  assert.strictEqual(healthData.smtpUser, undefined, "No internal SMTP credentials should leak in /health");
  console.log("  ✅ Health check passed. Zero internal configuration leaked.\n");

  // Test 2: Queue counter
  console.log("▶ [Test 2] Queue Counter (/api/waitlist/count)...");
  const countRes = await fetch(`${BASE_URL}/api/waitlist/count`);
  assert.strictEqual(countRes.status, 200);
  const countData = await countRes.json();
  assert.strictEqual(countData.success, true);
  assert.strictEqual(typeof countData.count, "number");
  assert.strictEqual(typeof countData.nextNumber, "number");
  console.log(`  ✅ Live queue counter works (Total signups: ${countData.count}, Next spot: #${countData.nextNumber}).\n`);

  // Test 3: Unauthenticated admin endpoints must be blocked (403)
  console.log("▶ [Test 3] Data Leak Prevention on Admin Endpoints...");
  const unauthEmailsRes = await fetch(`${BASE_URL}/api/emails`);
  assert.strictEqual(unauthEmailsRes.status, 403, "/api/emails must block unauthenticated access with 403");

  const unauthExportRes = await fetch(`${BASE_URL}/api/waitlist/export`);
  assert.strictEqual(unauthExportRes.status, 403, "/api/waitlist/export must block unauthenticated access with 403");
  console.log("  ✅ Unauthenticated data dump requests successfully blocked with 403.\n");

  // Test 4: Authenticated admin endpoints with secret key
  console.log("▶ [Test 4] Authenticated Admin Access with Secret Key...");
  const authEmailsRes = await fetch(`${BASE_URL}/api/emails`, {
    headers: { "x-admin-key": ADMIN_KEY },
  });
  assert.strictEqual(authEmailsRes.status, 200);
  const authEmailsData = await authEmailsRes.json();
  assert.strictEqual(authEmailsData.success, true);
  assert.ok(Array.isArray(authEmailsData.emails));
  console.log(`  ✅ Admin access verified with x-admin-key. Retrieved ${authEmailsData.count} email records.\n`);

  // Test 5: Position lookup without PII leakage
  console.log("▶ [Test 5] Sanitized Position Lookup (/api/waitlist/position)...");
  const posRes = await fetch(`${BASE_URL}/api/waitlist/position?email=keerthivardhanm@gmail.com`);
  assert.strictEqual(posRes.status, 200);
  const posData = await posRes.json();
  assert.strictEqual(posData.success, true);
  assert.strictEqual(posData.fullName, undefined, "Full name should not be leaked on public position check");
  assert.strictEqual(posData.email, undefined, "Email should not be leaked on public position check");
  assert.ok(posData.waitlistNumber, "Must return waitlist number");
  assert.ok(posData.referenceNumber, "Must return reference number");
  console.log(`  ✅ Position lookup returns sanitized sequence info (#${posData.waitlistNumber}, ${posData.referenceNumber}).\n`);

  console.log("🎉 All 5 verification tests passed successfully!\n");
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err.message);
  process.exit(1);
});

