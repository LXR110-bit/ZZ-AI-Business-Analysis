# gitclaw Private 仓库迁移说明

## 目标

- 源 GitHub：`https://github.com/LXR110-bit/ZZ-AI-Business-Analysis.git`
- 目标：gitclaw Private 项目 `ZZ-AI-Business-Analysis`
- 迁移后：新服务器只从 gitclaw 拉取部署；GitHub 保留为历史备份。

## 操作原则

1. token 不写入 remote URL。
2. token 不写入命令行、日志、README、`.env.example`。
3. 已暴露 token 必须 revoke 后重新生成。
4. gitclaw 项目设为 Private；协作人员用 Members/Group 授权。

## 推荐 remote 布局

```bash
git remote rename origin github
git remote add origin https://<gitclaw-host>/<group>/ZZ-AI-Business-Analysis.git
git remote -v
```

## 推送

```bash
git push -u origin main
git push origin --tags
```

如需保留 GitHub 备份：

```bash
git push github main
git push github --tags
```

## 服务器拉取

服务器使用只读或最小权限部署账号，从 gitclaw clone：

```bash
git clone https://<gitclaw-host>/<group>/ZZ-AI-Business-Analysis.git /opt/soft/model-tag-monitor/app
```
