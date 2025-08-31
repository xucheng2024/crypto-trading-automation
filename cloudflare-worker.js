/**
 * Cloudflare Worker for triggering GitHub Actions
 * Cron triggers: 每5分钟执行一次，避开整点时间
 */

// GitHub 配置
const GITHUB_OWNER = 'xucheng2024';
const GITHUB_REPO = 'crypto-trading-automation';
const GITHUB_TOKEN = 'YOUR_GITHUB_TOKEN'; // 需要设置环境变量

// 每5分钟执行一次，避开整点 (02, 07, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57)
export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    console.log(`🕐 Cron triggered: ${cron}`);
    
    try {
      // 触发 GitHub repository_dispatch
      const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${env.GITHUB_TOKEN || GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Cloudflare-Worker-Cron'
        },
        body: JSON.stringify({
          event_type: 'cron',
          client_payload: {
            timestamp: new Date().toISOString(),
            source: 'cloudflare-worker',
            cron_schedule: cron
          }
        })
      });

      if (response.ok) {
        console.log('✅ GitHub Actions triggered successfully');
        return new Response('OK', { status: 200 });
      } else {
        const errorText = await response.text();
        console.error(`❌ Failed to trigger GitHub Actions: ${response.status} - ${errorText}`);
        return new Response(`Error: ${response.status}`, { status: response.status });
      }
    } catch (error) {
      console.error('❌ Error triggering GitHub Actions:', error);
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  },

  // 手动测试接口
  async fetch(request, env, ctx) {
    if (request.method === 'POST') {
      // 手动触发
      return this.scheduled({ cron: 'manual' }, env, ctx);
    }
    
    return new Response(`
      <h1>🚀 Crypto Trading Automation Cron Worker</h1>
      <p>Status: Active</p>
      <p>GitHub Repo: ${GITHUB_OWNER}/${GITHUB_REPO}</p>
      <p>POST to this endpoint to manually trigger</p>
      <hr>
      <h2>📅 Cron Schedule:</h2>
      <ul>
        <li>每5分钟: 02, 07, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57</li>
        <li>每天23:54: 取消待处理触发器</li>
        <li>每天00:06: 创建算法触发器</li>
      </ul>
    `, {
      headers: { 'Content-Type': 'text/html' }
    });
  }
};
