FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
ENV HOST=0.0.0.0
ENV PORT=4810
EXPOSE 4810
CMD ["npx", "tsx", "src/server.ts"]
