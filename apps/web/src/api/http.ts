import axios, { type AxiosError } from 'axios';

/**
 * 公开前台专用 axios 实例。
 * - 不带 token、不做 401 跳登录（前台没有登录态）
 * - baseURL 用同源相对路径 '/api'，由 nginx 反代到后端（见 deploy/nginx/）
 */
const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 30000,
});

http.interceptors.response.use(
  (res) => res.data,
  (err: AxiosError) => {
    // 前台不做全局弹窗（不引 UI 库），只留控制台线索，由页面自己渲染错误态
    // eslint-disable-next-line no-console
    console.warn('[api]', err.config?.url, err.response?.status ?? err.message);
    return Promise.reject(err.response?.data ?? err);
  },
);

export default http;
