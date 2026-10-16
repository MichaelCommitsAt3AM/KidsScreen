FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=7879 KIDSSCREEN_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7879
CMD ["node", "dist/server.js"]
