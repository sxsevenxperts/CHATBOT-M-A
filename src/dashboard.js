import express from 'express';
import cors from 'cors';
import { getTriages, updateTriageStatus } from './database.js';

export function initDashboard(port) {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(express.static('public'));

  // Middleware de autenticação simples
  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';

  app.use((req, res, next) => {
    if (req.path === '/api/login') return next();

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Não autenticado' });
    }

    const token = auth.substring(7);
    if (token !== DASHBOARD_PASSWORD) {
      return res.status(403).json({ error: 'Credenciais inválidas' });
    }

    next();
  });

  // Login
  app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === DASHBOARD_PASSWORD) {
      res.json({ token: DASHBOARD_PASSWORD });
    } else {
      res.status(401).json({ error: 'Senha incorreta' });
    }
  });

  // GET triagens
  app.get('/api/triages', async (req, res) => {
    try {
      const triages = await getTriages();
      res.json(triages);
    } catch (error) {
      console.error('Erro ao buscar triagens:', error);
      res.status(500).json({ error: 'Erro ao buscar triagens' });
    }
  });

  // PUT status da triagem
  app.put('/api/triages/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!['pending', 'contacted', 'completed', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Status inválido' });
      }

      const updated = await updateTriageStatus(id, status);
      res.json(updated);
    } catch (error) {
      console.error('Erro ao atualizar triagem:', error);
      res.status(500).json({ error: 'Erro ao atualizar triagem' });
    }
  });

  // Serve dashboard HTML
  app.get('/', (req, res) => {
    res.send(getDashboardHTML());
  });

  app.listen(port, () => {
    console.log(`\n📊 Dashboard iniciado em http://localhost:${port}`);
    console.log(`🔐 Senha padrão: ${DASHBOARD_PASSWORD}\n`);
  });
}

function getDashboardHTML() {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>M & A Dashboard - Triagens</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }

    .login-container {
      max-width: 400px;
      margin: 50px auto;
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.2);
      text-align: center;
    }

    .login-container h1 {
      margin-bottom: 30px;
      color: #333;
    }

    .login-container input {
      width: 100%;
      padding: 12px;
      margin-bottom: 20px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 16px;
    }

    .login-container button {
      width: 100%;
      padding: 12px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 16px;
      cursor: pointer;
      font-weight: bold;
    }

    .login-container button:hover {
      background: #764ba2;
    }

    .dashboard {
      display: none;
      max-width: 1200px;
      margin: 0 auto;
    }

    .header {
      background: white;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .header h1 {
      color: #333;
    }

    .logout-btn {
      background: #ff6b6b;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: bold;
    }

    .triages-table {
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th {
      background: #f5f5f5;
      padding: 15px;
      text-align: left;
      font-weight: bold;
      color: #333;
      border-bottom: 2px solid #ddd;
    }

    td {
      padding: 15px;
      border-bottom: 1px solid #eee;
    }

    tr:hover {
      background: #fafafa;
    }

    .status {
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
      color: white;
      cursor: pointer;
    }

    .status.pending { background: #ffc107; color: #333; }
    .status.contacted { background: #17a2b8; }
    .status.completed { background: #28a745; }
    .status.rejected { background: #dc3545; }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: #999;
    }

    .refresh-btn {
      background: #667eea;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="login-container" id="loginContainer">
    <h1>🔐 Dashboard M & A</h1>
    <input type="password" id="passwordInput" placeholder="Senha" />
    <button onclick="login()">Entrar</button>
  </div>

  <div class="dashboard" id="dashboard">
    <div class="header">
      <div>
        <h1>📊 Triagens M & A Lava a Jato</h1>
        <p style="color: #999; margin-top: 5px;">Gerenciar pedidos de atendimento</p>
      </div>
      <div>
        <button class="refresh-btn" onclick="loadTriages()">🔄 Atualizar</button>
        <button class="logout-btn" onclick="logout()">Sair</button>
      </div>
    </div>

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
          <tr>
            <td colspan="7" class="empty-state">Carregando...</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    const token = localStorage.getItem('dashboardToken');

    if (token) {
      document.getElementById('loginContainer').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      loadTriages();
      setInterval(loadTriages, 10000);
    }

    async function login() {
      const password = document.getElementById('passwordInput').value;
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });

        if (res.ok) {
          const data = await res.json();
          localStorage.setItem('dashboardToken', data.token);
          document.getElementById('loginContainer').style.display = 'none';
          document.getElementById('dashboard').style.display = 'block';
          loadTriages();
          setInterval(loadTriages, 10000);
        } else {
          alert('Senha incorreta');
        }
      } catch (error) {
        alert('Erro ao fazer login');
      }
    }

    async function loadTriages() {
      const token = localStorage.getItem('dashboardToken');
      try {
        const res = await fetch('/api/triages', {
          headers: { 'Authorization': 'Bearer ' + token }
        });

        if (!res.ok) {
          logout();
          return;
        }

        const triages = await res.json();
        const tbody = document.getElementById('triagesBody');

        if (triages.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Nenhuma triagem ainda</td></tr>';
          return;
        }

        tbody.innerHTML = triages.map(t => \`
          <tr>
            <td>\${t.name}</td>
            <td><a href="https://wa.me/\${t.phone}" target="_blank">\${formatPhone(t.phone)}</a></td>
            <td>\${t.vehicle}</td>
            <td>\${t.service}</td>
            <td>\${t.is_customer ? '✅' : '❌'}</td>
            <td>\${new Date(t.created_at).toLocaleString('pt-BR')}</td>
            <td>
              <select class="status \${t.status}" onchange="updateStatus(\${t.id}, this.value)">
                <option value="pending" \${t.status === 'pending' ? 'selected' : ''}>⏳ Pendente</option>
                <option value="contacted" \${t.status === 'contacted' ? 'selected' : ''}>📞 Contatado</option>
                <option value="completed" \${t.status === 'completed' ? 'selected' : ''}>✅ Concluído</option>
                <option value="rejected" \${t.status === 'rejected' ? 'selected' : ''}>❌ Rejeitado</option>
              </select>
            </td>
          </tr>
        \`).join('');
      } catch (error) {
        console.error('Erro:', error);
      }
    }

    async function updateStatus(id, status) {
      const token = localStorage.getItem('dashboardToken');
      try {
        await fetch(\`/api/triages/\${id}\`, {
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ status })
        });
        loadTriages();
      } catch (error) {
        alert('Erro ao atualizar status');
      }
    }

    function formatPhone(phone) {
      return phone.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
    }

    function logout() {
      localStorage.removeItem('dashboardToken');
      location.reload();
    }
  </script>
</body>
</html>
  `;
}
