dockerfile_content = '''FROM node:18-alpine

# Install TypeScript globally
RUN npm install -g typescript ts-node

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/
COPY .env ./

# Build the TypeScript code
RUN npm run build

# Expose the port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
'''