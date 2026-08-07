# Node 22+: o @supabase/supabase-js precisa do WebSocket global, que não
# existe no Node 20 ("native WebSocket not found") e derruba o initSupabase.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependências primeiro: aproveita o cache de layer entre deploys.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# 3000 = padrão; 3001 fica exposta porque o domínio do EasyPanel pode
# estar apontado para ela (o app escuta nas duas).
EXPOSE 3000 3001

CMD ["node", "src/index.js"]
