# 冒烟测试用例管理（smoke-ui）部署说明

单文件前端 + 零依赖 Node 服务，数据存储于服务器 `cases.json`，多台电脑共享同一份用例数据。
同时承担**测试结果展示**与**测试用例获取/上传**：提供 AI/自动化可调的用例 API、报告上传与
「浏览测试结果」页面（通过率趋势折线图 + 时间文件夹链接）。

## 目录结构

```
smoke-ui/
├── index.html        # 前端页面（用例管理 + 浏览测试结果）
├── server.js         # Node 服务（零依赖，原生 http，含用例/结果/报告 API）
├── report-upload.js  # 上传脚本（run-smoke-test 结束后把 out/<时间戳>/ 上传 + 回写结果）
├── cases.json        # 用例数据（运行时生成，首次打开页面自动初始化种子 272 条）
├── cases.json.bak    # 自动备份（每次写入前保留上一份）
├── reports/          # 测试报告（运行时生成，run-smoke-test 上传，gitignore）
└── README.md
```

> `report-upload.js` 只部署在**开发机**（执行冒烟测试的机器），用于向服务器上传报告；
> 服务器只需 `index.html` + `server.js` 两个文件（`reports/` 由服务端运行时自动创建）。

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
# 数据目录权限：service 用户需对 /opt/smoke-ui 可写（含 reports/ 报告目录）
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
        client_max_body_size 0;            # 报告含录屏，允许大文件上传
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
| `reports/<runId>/` | 每次 run-smoke-test 上传的测试报告（`summary.json` + `index.html` + 模块报告 + 证据） |

**建议备份策略**（cron 每日）：

```bash
# crontab -e
0 2 * * * cp /opt/smoke-ui/cases.json /opt/smoke-ui/backup/cases-$(date +\%F).json
```

也可在页面内用「⇩ xlsx」导出做人工备份。

## 用例编号与配置

- 每条用例有持久化的唯一编号 = **模块码 - 序号**（如 `CAM-001`）；序号在「项目 + 模块码」组内自动续编，删除不复用。
- 用例额外带 `project`（项目）、`moduleCode`（模块码）、`type`（类型）、`caseNo`（序号）字段，均随 `cases.json` 同步。
- 导入导出会保留编号：xlsx 增加「编号」列（`模块码-序号`），Markdown 首行标记写入 `no` 属性并在正文附 `**编号**` 字段，导入时据此还原序号。
- 页面右上角「⚙ 配置」可管理 **项目 / 模块码 / 类型** 三组参数（增删改），配置存于 `cases.json` 的 `config` 字段，多台电脑共享。
- 用例还带 `lastResult`（最近测试结果：空=未执行 / pass / partial / blocked / fail / skip）与 `resultRunId`（哪次运行回写的），由 run-smoke-test 结果回写自动更新。

## AI / 自动化接入 API（供 AI 修改、上传、下载用例）

所有接口返回/接收 JSON（除注明），服务地址以 `http://<host>:8899` 为例：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cases` | 读取用例列表（`{ version, config, cases, updatedAt }`） |
| POST | `/api/cases` | 全量保存（前端整表同步，带 `baseUpdatedAt` 冲突检测） |
| GET | `/api/cases/export` | 下载全部用例：`?format=json`(默认) 或 `?format=md`(冒烟 Markdown，可喂给 run-smoke-test) |
| POST | `/api/cases/import` | 批量上传/合并：`{ cases:[...] }`；按 `id` 或 `(moduleCode,caseNo)` 去重 upsert |
| GET | `/api/cases/:id` | 读取单条用例 |
| PUT | `/api/cases/:id` | 修改单条用例（body 为字段集合，last-write-wins；可选带 `baseUpdatedAt` 做乐观锁） |
| DELETE | `/api/cases/:id` | 删除单条用例 |
| POST | `/api/results` | 回写测试结果：`{ runId, results:[{id|moduleCode+caseNo|title+project, result}] }` |
| PUT | `/api/reports/:runId/<文件路径>` | 上传一个报告文件（原始 body，自动建目录，防路径穿越） |
| GET | `/api/reports` | 列出全部测试报告（时间、模块、通过率、计数等；`?days=7|30` 过滤） |
| GET | `/api/reports/:runId` | 读取某次运行的 summary.json |

用例字段（写接口白名单）：`title, module, project, moduleCode, type, caseNo,
priority, preconditions, steps, stepTypes, expected, inSmoke, smokePkg,
smokeActivity, smokeSrc, lastResult, resultRunId, resultNote`。

结果状态归一：`PASS`→`pass`、`PARTIAL`/`PASS（部分）`→`partial`、
`FAIL`/`缺陷`→`fail`、`INTERRUPTED`/`阻塞`→`blocked`、`NOT_EXECUTED`/`跳过`→`skip`。

### 回写结果示例

```bash
curl -X POST http://<host>:8899/api/results \
  -H 'Content-Type: application/json' \
  -d '{"runId":"20260812_153000","results":[
        {"moduleCode":"CNT_FRIEND","caseNo":"001","project":"718","title":"浏览朋友圈列表","result":"PASS"},
        {"moduleCode":"CNT_FRIEND","caseNo":"002","project":"718","title":"发布文字","result":"FAIL"}
      ]}'
```

## 测试结果浏览

- 首页入口「浏览测试结果」进入结果页（原「上传测试结果」占位已替换）。
- 页面顶部以**时间为横轴、通过率为纵轴**绘制冒烟测试通过率折线图，可切换
  **最近 7 天 / 最近 30 天 / 全部**。
- 下方按时间倒序列出每次运行的时间文件夹链接，链接后附**当次通过率**与
  通过/失败/部分/中断/跳过计数；点击进入该次运行的汇总报告 `reports/<runId>/index.html`。
- 通过率 = `passed / total`（0~1），由 `summary.json` 提供；缺 `summary.json`
  时该次运行通过率显示为「—」，趋势图跳过该点。

## run-smoke-test 集成

`/run-smoke-test` 执行结束、生成 `out/<时间戳>/index.html` 汇总报告后，需同步：

1. 产出机器可读摘要 `out/<时间戳>/summary.json`（字段见 run-smoke-test 技能第七步）。
2. 在开发机仓库根目录执行上传脚本：

   ```bash
   SMOKE_UI_URL=http://<host>:8899 node smoke-ui/report-upload.js out/<YYYYMMDD_HHMMSS>/
   ```

   脚本把 `out/<时间戳>/` 下所有文件上传到服务器 `reports/<runId>/`，并
   `POST /api/results` 回写每条用例的 `lastResult` / `resultRunId`。
   `--no-writeback` 只上传不回写；`--url http://host:port` 直接指定服务器。

## 并发与冲突

- 多用户同时编辑时采用**最后写入者胜**，但带版本检测：整表写入携带上次读取的服务器版本，若期间被他人修改，服务端返回 409，页面自动拉取最新并提示"请重新编辑"。
- 单条修改（`PUT /api/cases/:id`）与结果回写（`POST /api/results`）为**最后写入者胜**，不强制版本号（可选 `baseUpdatedAt` 乐观锁）。

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
| 「浏览测试结果」空白/无报告 | 确认已用 `report-upload.js` 上传、服务器 `reports/` 目录存在且服务进程可写；查看 `/api/reports` 返回 |
| 上传大报告失败 | Nginx `client_max_body_size 0`；直连端口则检查 `server.js` 的 `MAX_UPLOAD` |
| 报告内截图/录屏打不开（中文路径） | 确认 server.js 静态服务已 `decodeURIComponent`（本版本已处理），浏览器用相对链接跳转 |
| 中文乱码 | 确保 `LANG=zh_CN.UTF-8` 或 `en_US.UTF-8`；server.js 已强制 UTF-8 读写 |
