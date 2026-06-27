FROM node:22-bookworm-slim

WORKDIR /app

COPY tld-monitoring-deployable/package*.json ./

RUN npm install --omit=dev

COPY tld-monitoring-deployable/ .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
