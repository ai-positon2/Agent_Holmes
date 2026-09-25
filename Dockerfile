FROM node:20-alpine
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/index.js ./
COPY landing/ ./landing/
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
