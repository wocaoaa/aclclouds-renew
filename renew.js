const { chromium } = require('playwright');
const https = require('https');

const EMAIL = process.env.ACL_EMAIL;
const PASSWORD = process.env.ACL_PASSWORD;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const BASE_URL = 'https://dash.aclclouds.com';

// Send Telegram notification
async function notify(message) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log('[TG] No bot token or chat ID, skipping notification');
    return;
  }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: TG_CHAT_ID,
    text: message,
    parse_mode: 'HTML'
  });
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('[TG] Notification sent');
        resolve(data);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('=== ACLClouds Auto-Renew ===');
  console.log(`Time: ${new Date().toISOString()}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    // Step 1: Go to login page
    console.log('[1] Loading login page...');
    await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'networkidle' });

    // Step 2: Fill credentials
    console.log('[2] Filling credentials...');
    await page.fill('#username', EMAIL);
    await page.fill('#password', PASSWORD);

    // Step 3: Click the custom captcha checkbox
    console.log('[3] Solving captcha...');
    const captcha = page.locator('.auth-captcha-inner').first();
    
    // Simulate some mouse movement before clicking
    const box = await captcha.boundingBox();
    if (box) {
      await page.mouse.move(box.x - 50, box.y - 30);
      await page.waitForTimeout(300);
      await page.mouse.move(box.x + 10, box.y + 10);
      await page.waitForTimeout(200);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(150);
    }
    
    await captcha.click();
    
    // Wait for verification
    await page.waitForTimeout(3000);
    
    // Check if verified
    const verified = await page.locator('.auth-captcha-box.verified').count();
    if (verified === 0) {
      // Try clicking again
      console.log('[3b] Retrying captcha...');
      await captcha.click();
      await page.waitForTimeout(3000);
    }
    
    const finalCheck = await page.locator('.auth-captcha-box.verified').count();
    console.log(`  Captcha verified: ${finalCheck > 0}`);

    // Step 4: Click sign in
    console.log('[4] Signing in...');
    await page.click('button:has-text("Sign in")');
    
    // Wait for navigation
    try {
      await page.waitForURL('**/', { timeout: 15000 });
    } catch (e) {
      await page.screenshot({ path: '/tmp/acl_login_error.png' });
      throw new Error('Login failed - did not redirect to dashboard');
    }
    
    await page.waitForTimeout(2000);
    console.log('[OK] Logged in!');

    // Step 5: Get server list via API
    console.log('[5] Fetching servers...');
    const serversResp = await page.evaluate(async () => {
      const r = await fetch('/api/client');
      return r.json();
    });

    if (serversResp.errors) {
      console.error('[FAIL] API error:', JSON.stringify(serversResp.errors));
      await notify(`❌ ACLClouds Renew Failed\nAPI Error: ${JSON.stringify(serversResp.errors)}`);
      process.exit(1);
    }

    const servers = serversResp.data;
    console.log(`[5] Found ${servers.length} server(s)`);

    // Step 6: Renew each server
    let results = [];
    let hasRenewed = false;
    for (const server of servers) {
      const { uuid, name, can_renew, expires_at } = server.attributes;
      console.log(`\n--- Server: ${name} (${uuid}) ---`);
      console.log(`  Expires: ${expires_at}`);
      console.log(`  Can renew: ${can_renew}`);

      if (can_renew) {
        console.log('  [RENEWING]...');
        const renewResp = await page.evaluate(async (uuid) => {
          const r = await fetch(`/api/client/servers/${uuid}/upgrade/renew`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          return r.json();
        }, uuid);

        console.log('  Response:', JSON.stringify(renewResp));

        if (renewResp.error) {
          console.log(`  ⚠️ ${name}: ${renewResp.error}`);
          results.push(`⚠️ ${name}: ${renewResp.error}`);
        } else if (renewResp.requires_payment) {
          console.log(`  💰 ${name}: Requires payment`);
          results.push(`💰 ${name}: Requires payment`);
        } else {
          console.log(`  ✅ ${name}: Renewed successfully!`);
          results.push(`✅ ${name}: Renewed!`);
          hasRenewed = true;
        }
      } else {
        console.log(`  ⏳ ${name}: Not available yet (expires: ${expires_at})`);
        results.push(`⏳ ${name}: Not available yet (expires: ${expires_at})`);
      }
    }

    // Step 7: Send Telegram notification
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const msg = `☁️ <b>ACLClouds Auto-Renew</b>\n⏰ ${now}\n\n${results.join('\n')}`;
    await notify(msg);

    console.log('\n=== Summary ===');
    results.forEach(r => console.log(r));
    console.log('\n=== Done ===');

  } catch (err) {
    console.error('Error:', err.message);
    await notify(`❌ ACLClouds Renew Error\n${err.message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
