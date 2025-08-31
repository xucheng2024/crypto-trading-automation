/**
 * Cloudflare Worker for triggering GitHub Actions
 * Cron triggers: 每5分钟和每15分钟执行不同脚本组合
 */

// GitHub 配置
const GITHUB_OWNER = 'xucheng2024';
const GITHUB_REPO = 'crypto-trading-automation';
const GITHUB_TOKEN = 'YOUR_GITHUB_TOKEN'; // 需要设置环境变量

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    console.log(`🕐 Cron triggered: ${cron}`);
    
    try {
      // 根据cron频率决定触发哪些脚本
      let scripts = [];
      
      if (cron.includes('*/7')) {
        // 每7分钟执行: monitor_delist + cancel_pending_limits
        scripts = ['monitor_delist', 'cancel_pending_limits'];
        console.log('📅 7-minute interval: monitor_delist + cancel_pending_limits');
      } else if (cron.includes('0,15,30,45')) {
        // 每15分钟执行: fetch_filled_orders + auto_sell_orders (整点)
        scripts = ['fetch_filled_orders', 'auto_sell_orders'];
        console.log('📅 15-minute interval: fetch_filled_orders + auto_sell_orders');
      } else if (cron.includes('55 23')) {
        // 每天23:55: 取消待处理触发器
        scripts = ['cancel_pending_triggers'];
        console.log('🌙 Nightly: cancel_pending_triggers');
      } else if (cron.includes('5 0')) {
        // 每天00:05: 创建算法触发器
        scripts = ['create_algo_triggers'];
        console.log('🌅 Morning: create_algo_triggers');
      }
      
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
            cron_schedule: cron,
            scripts: scripts,
            interval: cron.includes('*/5') ? '5min' : cron.includes('*/15') ? '15min' : 'daily'
          }
        })
      });

      if (response.ok) {
        console.log(`✅ GitHub Actions triggered successfully for: ${scripts.join(', ')}`);
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
        <li><strong>每7分钟</strong>: monitor_delist.py + cancel_pending_limits.py</li>
        <li><strong>每15分钟</strong>: fetch_filled_orders.py + auto_sell_orders.py</li>
        <li><strong>每天23:55</strong>: cancel_pending_triggers.py</li>
        <li><strong>每天00:05</strong>: create_algo_triggers.py</li>
      </ul>
      <hr>
      <h2>🔧 执行逻辑:</h2>
      <ul>
        <li>7分钟间隔: 监控和保护 + 取消限价单</li>
        <li>15分钟间隔: 获取已完成订单 + 自动卖出</li>
        <li>夜间任务: 取消待处理触发器</li>
        <li>早晨任务: 创建算法触发器</li>
      </ul>
    `, {
      headers: { 'Content-Type': 'text/html' }
    });
  }
};
