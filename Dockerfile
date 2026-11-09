FROM node:20-slim

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies
RUN npm install

# Copy application code
COPY . .

# Hugging Face Spaces binds to port 7860 by default
ENV PORT=7860
EXPOSE 7860

CMD ["npm", "start"]
