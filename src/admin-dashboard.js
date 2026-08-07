import express from 'express';
import axios from 'axios';
import { getSupabase, getTriages, updateTriageStatus } from './database.js';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

const evolutionClient = axios.create({
  baseURL: EVOLUTION_API_URL,
  headers: {
    'apikey': EVOLUTION_API_KEY,
    'Content-Type': 'application/json'
  }
});

export function setupAdminRoutes(app) {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

  const authMiddleware = (req, res, next) => {
    if (req.path === '/admin/api/login') return next();
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });
    if (auth.substring(7) !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Credenciais inválidas' });
    next();
  };

  // Login
  app.post('/admin/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
      res.json({ token: ADMIN_PASSWORD });
    } else {
      res.status(401).json({ error: 'Senha incorreta' });
    }
  });

  // Middleware de auth para rotas protegidas
  app.use('/admin/api', authMiddleware);

  // Evolution API - Listar instâncias
  app.get('/admin/api/evolution/instances', async (req, res) => {
    try {
      const { data } = await evolutionClient.get('/instance/fetchInstances');
      res.json(data.instances || []);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Evolution API - Conectar nova instância
  app.post('/admin/api/evolution/connect', async (req, res) => {
    try {
      const { instanceName } = req.body;

      if (!instanceName) {
        return res.status(400).json({ error: 'Nome da instância é obrigatório' });
      }

      const { data } = await evolutionClient.post('/instance/create', {
        instanceName: instanceName,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS'
      });

      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ error: error.response?.data || error.message });
    }
  });

  // Evolution API - QR Code
  app.get('/admin/api/evolution/qr/:instanceName', async (req, res) => {
    try {
      const { instanceName } = req.params;
      const { data } = await evolutionClient.get(`/instance/fetchInstances`);

      const instance = data.instances?.find(i => i.name === instanceName);
      if (!instance) {
        return res.status(404).json({ error: 'Instância não encontrada' });
      }

      res.json({
        qrcode: instance.qrcode,
        connected: instance.connectionStatus === 'open',
        phone: instance.me?.id
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Triagens
  app.get('/admin/api/triages', async (req, res) => {
    try {
      const triages = await getTriages();
      res.json(triages);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Atualizar triagem
  app.put('/admin/api/triages/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      const updated = await updateTriageStatus(id, status);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Dashboard HTML
  app.get('/admin', (req, res) => {
    res.send(getDashboardHTML());
  });
}

function getDashboardHTML() {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>M & A Admin Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 1px solid #1e293b;
    }
    .header h1 { font-size: 28px; color: #60a5fa; }
    .logout-btn {
      background: #ef4444;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: bold;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 30px;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 20px;
    }
    .card h2 {
      color: #60a5fa;
      margin-bottom: 15px;
      font-size: 18px;
    }
    .qr-container {
      text-align: center;
      padding: 20px;
      background: white;
      border-radius: 8px;
      margin: 15px 0;
    }
    .qr-container img {
      max-width: 300px;
      height: auto;
    }
    .status {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
      margin: 5px 0;
    }
    .status.connected { background: #10b981; color: white; }
    .status.pending { background: #f59e0b; color: white; }
    .status.error { background: #ef4444; color: white; }
    .form-group {
      margin-bottom: 15px;
    }
    .form-group label {
      display: block;
      margin-bottom: 5px;
      font-weight: 600;
      color: #cbd5e1;
    }
    .form-group input,
    .form-group select {
      width: 100%;
      padding: 10px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 4px;
      color: #e2e8f0;
      font-size: 14px;
    }
    .btn {
      background: #60a5fa;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: bold;
      width: 100%;
    }
    .btn:hover { background: #3b82f6; }
    .triages-table {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 15px;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #334155;
    }
    th {
      background: #0f172a;
      font-weight: bold;
      color: #60a5fa;
    }
    tr:hover { background: #1e293b; }
    .select-status {
      padding: 6px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 4px;
      color: #e2e8f0;
      cursor: pointer;
    }
    .messages-box {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 4px;
      padding: 15px;
      height: 400px;
      overflow-y: auto;
      margin-top: 15px;
    }
    .message {
      padding: 10px;
      margin: 8px 0;
      border-radius: 4px;
      font-size: 13px;
    }
    .message.bot { background: #1e3a8a; color: #93c5fd; }
    .message.user { background: #15803d; color: #86efac; }
    .message.system { background: #7c2d12; color: #fed7aa; }
    .login-container {
      display: none;
      max-width: 400px;
      margin: 50px auto;
      background: #1e293b;
      padding: 40px;
      border-radius: 8px;
      border: 1px solid #334155;
      text-align: center;
    }
    .login-container h1 {
      color: #60a5fa;
      margin-bottom: 30px;
    }
    .login-container input {
      width: 100%;
      padding: 12px;
      margin-bottom: 20px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 4px;
      color: #e2e8f0;
    }
    .full-width { grid-column: 1 / -1; }
  </style>
</head>
<body>
  <div class="login-container" id="loginContainer">
    <h1>🔐 M & A Admin</h1>
    <input type="password" id="passwordInput" placeholder="Senha" />
    <button class="btn" onclick="login()">Entrar</button>
  </div>

  <div id="dashboard" style="display: none;">
    <div class="header">
      <div>
        <h1>🚀 M & A WhatsApp Bot - Admin Dashboard</h1>
        <p style="color: #94a3b8; margin-top: 5px;">Gerenciamento de Instâncias e Triagens</p>
      </div>
      <button class="logout-btn" onclick="logout()">Sair</button>
    </div>

    <div class="container">
      <div class="grid">
        <!-- Evolution API Connection -->
        <div class="card">
          <h2>📱 Conectar WhatsApp</h2>
          <div class="form-group">
            <label>Nome da Instância</label>
            <input type="text" id="instanceName" placeholder="ex: lavaajatoma" />
          </div>
          <button class="btn" onclick="connectInstance()">Conectar</button>
          <div id="qrContainer"></div>
          <div id="instanceStatus" style="margin-top: 15px;"></div>
        </div>

        <!-- Instâncias Conectadas -->
        <div class="card">
          <h2>✅ Instâncias Ativas</h2>
          <div id="instancesList" style="margin-top: 15px;"></div>
          <button class="btn" onclick="refreshInstances()" style="margin-top: 15px;">🔄 Atualizar</button>
        </div>
      </div>

      <!-- Triagens -->
      <div class="card full-width">
        <h2>📋 Triagens em Progresso</h2>
        <div class="triages-table">
          <table id="triagesTable">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Telefone</th>
                <th>Veículo</th>
                <th>Serviço</th>
                <th>Cliente</th>
                <th>Data</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="triagesBody">
              <tr><td colspan="7" style="text-align: center; color: #64748b;">Carregando...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Mensagens em Tempo Real -->
      <div class="card full-width">
        <h2>💬 Fluxo de Mensagens</h2>
        <div class="messages-box" id="messagesBox">
          <div class="message system">Aguardando mensagens...</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const token = localStorage.getItem('adminToken');
    if (token) {
      document.getElementById('loginContainer').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      loadData();
      setInterval(loadData, 5000);
    }

    async function login() {
      const password = document.getElementById('passwordInput').value;
      const res = await fetch('/admin/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });

      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('adminToken', data.token);
        document.getElementById('loginContainer').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';
        loadData();
        setInterval(loadData, 5000);
      } else {
        alert('Senha incorreta');
      }
    }

    async function loadData() {
      await loadTriages();
      await refreshInstances();
    }

    async function loadTriages() {
      const token = localStorage.getItem('adminToken');
      const res = await fetch('/admin/api/triages', {
        headers: { 'Authorization': 'Bearer ' + token }
      });

      if (!res.ok) { logout(); return; }

      const triages = await res.json();
      const tbody = document.getElementById('triagesBody');

      if (!triages.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #64748b;">Nenhuma triagem</td></tr>';
        return;
      }

      tbody.innerHTML = triages.map(t => \`
        <tr>
          <td>\${t.name}</td>
          <td><a href="https://wa.me/\${t.phone}" target="_blank" style="color: #60a5fa;">\${formatPhone(t.phone)}</a></td>
          <td>\${t.vehicle}</td>
          <td>\${t.service}</td>
          <td>\${t.is_customer ? '✅' : '❌'}</td>
          <td>\${new Date(t.created_at).toLocaleString('pt-BR')}</td>
          <td>
            <select class="select-status" onchange="updateStatus(\${t.id}, this.value)">
              <option value="pending" \${t.status === 'pending' ? 'selected' : ''}>⏳ Pendente</option>
              <option value="contacted" \${t.status === 'contacted' ? 'selected' : ''}>📞 Contatado</option>
              <option value="completed" \${t.status === 'completed' ? 'selected' : ''}>✅ Concluído</option>
              <option value="rejected" \${t.status === 'rejected' ? 'selected' : ''}>❌ Rejeitado</option>
            </select>
          </td>
        </tr>
      \`).join('');
    }

    async function updateStatus(id, status) {
      const token = localStorage.getItem('adminToken');
      await fetch(\`/admin/api/triages/\${id}\`, {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status })
      });
      loadTriages();
    }

    async function connectInstance() {
      const instanceName = document.getElementById('instanceName').value;
      if (!instanceName) { alert('Digite o nome da instância'); return; }

      const token = localStorage.getItem('adminToken');
      const res = await fetch('/admin/api/evolution/connect', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ instanceName })
      });

      const data = await res.json();
      if (data.success) {
        document.getElementById('instanceStatus').innerHTML =
          \`<div class="status pending">⏳ Leia o QR Code no seu celular</div>\`;
        refreshInstances();
      } else {
        alert('Erro: ' + (data.error || 'Desconhecido'));
      }
    }

    async function refreshInstances() {
      const token = localStorage.getItem('adminToken');
      const res = await fetch('/admin/api/evolution/instances', {
        headers: { 'Authorization': 'Bearer ' + token }
      });

      if (!res.ok) return;

      const instances = await res.json();
      const html = instances.map(inst => \`
        <div style="padding: 10px; background: #0f172a; border-radius: 4px; margin: 8px 0; border: 1px solid #334155;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong>\${inst.name}</strong>
              <div style="font-size: 12px; color: #94a3b8; margin-top: 3px;">
                \${inst.me ? '📱 ' + inst.me.id : 'Aguardando conexão'}
              </div>
            </div>
            <span class="status \${inst.connectionStatus === 'open' ? 'connected' : 'pending'}">
              \${inst.connectionStatus === 'open' ? '✅ Conectado' : '⏳ Pendente'}
            </span>
          </div>
        </div>
      \`).join('');

      document.getElementById('instancesList').innerHTML = html || '<p style="color: #64748b;">Nenhuma instância conectada</p>';
    }

    function formatPhone(phone) {
      return phone.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
    }

    function logout() {
      localStorage.removeItem('adminToken');
      location.reload();
    }
  </script>
</body>
</html>
  `;
}
