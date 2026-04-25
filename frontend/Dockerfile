FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

# host: true is set in vite.config.ts so the dev server binds to 0.0.0.0
CMD ["npm", "run", "dev"]
