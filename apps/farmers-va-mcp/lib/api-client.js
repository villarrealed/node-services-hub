import axios from 'axios';

const PORT = process.env.PORT || 3000;
const API_BASE = process.env.RADD_API_BASE_URL || `http://localhost:${PORT}/farmers-va`;

const client = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

export default client;
