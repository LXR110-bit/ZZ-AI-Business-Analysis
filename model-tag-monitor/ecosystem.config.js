// pm2 守护配置
module.exports = {
  apps: [
    {
      name: 'model-tag-monitor',
      script: 'src/server.js',
      cwd: '/root/model-tag-monitor',
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 8848,
        FEISHU_APP_ID: 'cli_aab4e49b7bb95bd3',
      },
      out_file: '/root/model-tag-monitor/logs/out.log',
      error_file: '/root/model-tag-monitor/logs/err.log',
      time: true,
    },
  ],
};
