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
        DATA_DIR: '/root/model-tag-monitor/data/current',
        IMPORT_DIR: '/root/workspace/ZZ-AI-Business-Analysis-base-migration/data/imports',
        KEEP_WEEKS: '10',
        // Empty means each sync selects the latest KEEP_WEEKS from imported data.
        TARGET_WEEKS: '',
        DASHBOARD_URL: 'http://47.84.94.234:8848/?tab=dashboard',
        BOARD_METRICS_FEISHU_URL: 'https://zhuanspirit.feishu.cn/wiki/BVG1wCawniHIC5kn9eacgmP3nwX?from=from_copylink',
        BOARD_METRICS_FEISHU_SHEET: '大盘数据（周日均）',
        BOARD_METRICS_FEISHU_RANGE: 'A1:G80',
      },
      out_file: '/root/model-tag-monitor/logs/out.log',
      error_file: '/root/model-tag-monitor/logs/err.log',
      time: true,
    },
  ],
};
