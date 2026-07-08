// pm2 守护配置
module.exports = {
  apps: [
    {
      name: 'model-tag-monitor',
      script: 'src/server.js',
      cwd: '/root/model-tag-monitor',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1200M',
      env: {
        NODE_ENV: 'production',
        PORT: 8848,
        FEISHU_APP_ID: 'cli_aab4e49b7bb95bd3',
        IMPORT_DIR: '/root/workspace/ZZ-AI-Business-Analysis-base-migration/data/imports',
        KEEP_WEEKS: '10',
        TARGET_WEEKS: '2026-W19,2026-W20,2026-W21,2026-W22,2026-W23,2026-W24,2026-W25,2026-W26,2026-W27,2026-W28',
        DASHBOARD_URL: 'http://47.84.94.234:8848/?tab=dashboard',
      },
      out_file: '/root/model-tag-monitor/logs/out.log',
      error_file: '/root/model-tag-monitor/logs/err.log',
      time: true,
    },
  ],
};
