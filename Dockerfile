FROM node:22-bookworm-slim AS client
WORKDIR /app
COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client
COPY client ./client
ENV VITE_BASE=/
RUN npm run build --prefix client

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev --omit=optional --prefix server
COPY server ./server
COPY --from=client /app/client/dist ./client/dist
RUN mkdir -p /app/server/data/uploads
EXPOSE 4050
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4050)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
