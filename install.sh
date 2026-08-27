#!/usr/bin/env bash
# smoke-ui 一键部署脚本（Linux，需 root 或 sudo）
# 用法：上传本目录到服务器，执行  bash install.sh
set -e

INSTALL_DIR="/opt/smoke-ui"
PORT="${PORT:-8899}"
SERVICE_USER="${SERVICE_USER:-www-data}"

echo "== smoke-ui 部署 =="

# ---------- 1. Node.js 检测 ----------
if ! command -v node >/dev/null 2>&1; then
  echo "[!] 未检测到 Node.js"
  if [ "$(id -u)" -eq 0 ]; then
    echo "    尝试通过 apt 安装（内网无外网时请先离线安装 Node.js 再重试）..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || { echo "    安装源不可达，请手动安装 Node.js >= 18"; exit 1; }
    apt-get install -y nodejs
  else
    echo "    需要 root 权限安装，请先手动安装 Node.js >= 18 后重试"
    exit 1
  fi
fi
NODE_VER=$(node --version)
echo "[+] Node.js $NODE_VER"

# ---------- 2. 复制文件 ----------
mkdir -p "$INSTALL_DIR"
cp -f index.html server.js "$INSTALL_DIR/"
echo "[+] 文件已复制到 $INSTALL_DIR"

# ---------- 3. systemd 常驻服务 ----------
cat > /etc/systemd/system/smoke-ui.service <<EOF
[Unit]
Description=Smoke UI Case Manager
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
Environment=PORT=$PORT
User=$SERVICE_USER

[Install]
WantedBy=multi-user.target
EOF

# 数据目录需对服务用户可写
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR" 2>/dev/null || chmod -R 777 "$INSTALL_DIR"

systemctl daemon-reload
systemctl enable smoke-ui >/dev/null 2>&1 || true
systemctl restart smoke-ui
sleep 1

if systemctl is-active --quiet smoke-ui; then
  echo "[+] systemd 服务 smoke-ui 已启动"
else
  echo "[!] 服务启动失败，查看日志：journalctl -u smoke-ui -n 50"
  exit 1
fi

# ---------- 4. 输出访问地址 ----------
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "=============================================="
echo "  部署完成："
echo "    本机访问   http://127.0.0.1:$PORT"
echo "    内网访问   http://$IP:$PORT"
echo "    数据文件   $INSTALL_DIR/cases.json（自动备份 .bak）"
echo "    服务管理   systemctl {start|stop|restart|status} smoke-ui"
echo "    查看日志   journalctl -u smoke-ui -f"
echo "=============================================="
echo ""
echo "如需通过 80 端口访问，请配置 Nginx 反代（见 README.md）"
