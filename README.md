# 冒烟测试用例管理（smoke-ui）部署说明

单文件前端 + 零依赖 Node 服务，数据存储于服务器 `cases.json`，多台电脑共享同一份用例数据。

## 目录结构

```
smoke-ui/
├── index.html     # 前端页面（唯一页面）
├── server.js      # Node 服务（零依赖，原生 http）
├── cases.json     # 用例数据（运行时生成，首次打开页面自动初始化种子 272 条）
├── cases.json.bak # 自动备份（每次写入前保留上一份）
└── README.md
```

## Linux 部署

### 1. 安装 Node（已装可跳过）

```bash
# Debian/Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # 需 >= 18
```

### 2. 上传并启动

```bash
mkdir -p /opt/smoke-ui
# 将 index.html 与 server.js 上传到 /opt/smoke-ui
cd /opt/smoke-ui
node server.js                 # 前台启动，端口 8899
PORT=9000 node server.js       # 指定端口
```

### 3. systemd 常驻（推荐）

`/etc/systemd/system/smoke-ui.service`：

```ini
[Unit]
Description=Smoke UI Case Manager
After=network.target

[Service]
WorkingDirectory=/opt/smoke-ui
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
# 数据目录权限：service 用户需对 /opt/smoke-ui 可写
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now smoke-ui
sudo systemctl status smoke-ui
```

### 4. Nginx 反代（可选，走 80 端口）

`/etc/nginx/conf.d/smoke-ui.conf`：

```nginx
server {
    listen 80;
    server_name smoke.example.com;

    location / {
        proxy_pass http://127.0.0.1:8899;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 20m;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

访问：`http://smoke.example.com/`

### 5. 首次访问

- 浏览器打开页面 → 自动从服务器加载（服务器无数据时自动上传内置种子 272 条）
- 多台电脑访问同一 URL，看到同一份数据，编辑实时落盘 `cases.json`

## 数据与备份

| 文件 | 说明 |
|---|---|
| `cases.json` | 全部用例数据（原子写入：先写临时文件再改名，写一半崩溃不损坏） |
| `cases.json.bak` | 每次写入前的自动备份（保留最近一份） |

**建议备份策略**（cron 每日）：

```bash
# crontab -e
0 2 * * * cp /opt/smoke-ui/cases.json /opt/smoke-ui/backup/cases-$(date +\%F).json
```

也可在页面内用「⇩ xlsx」导出做人工备份。

## 并发与冲突

- 多用户同时编辑时采用**最后写入者胜**，但带版本检测：写入携带上次读取的服务器版本，若期间被他人修改，服务端返回 409，页面自动拉取最新并提示"请重新编辑"
- 冒烟用例管理为低频编辑场景，该策略足够；如需更强的多人实时协同（如锁定/合并），需引入数据库方案

## 前端行为（页面内置降级）

- **服务器可达**：数据以服务器为准，本地浏览器仅做缓存
- **服务器不可达**：自动降级离线模式（提示"离线模式"），编辑仅保存在本机浏览器，恢复后需重新打开页面同步
- 页面右上角无状态徽标；离线时保存会有红色提示

## Windows 备选（可选）

```bat
:: 前台运行
cd /d D:\work\AI\AATF\smoke-ui
node server.js

:: 开机自启：用 nssm 注册服务
nssm install smoke-ui "C:\Program Files\nodejs\node.exe" "D:\work\AI\AATF\smoke-ui\server.js"
nssm set smoke-ui AppDirectory "D:\work\AI\AATF\smoke-ui"
nssm start smoke-ui
```

## 故障排查

| 现象 | 处理 |
|---|---|
| 页面显示"服务器不可达" | `systemctl status smoke-ui`、检查端口 `ss -tlnp \| grep 8899`、Nginx 反代是否生效 |
| 保存报 409 提示被他人更新 | 属正常并发保护，重新编辑即可 |
| cases.json 损坏无法启动 | 用 `cases.json.bak` 恢复：`cp cases.json.bak cases.json` 后重启服务 |
| 中文乱码 | 确保 `LANG=zh_CN.UTF-8` 或 `en_US.UTF-8`；server.js 已强制 UTF-8 读写 |
