FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

# Install the Brave MCP server globally so it's available as a command
RUN npm install -g @brave/brave-search-mcp-server

ENTRYPOINT ["node", "dist/cli.js"]
