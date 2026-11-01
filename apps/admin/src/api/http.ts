import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { ElMessage } from 'element-plus';

const TOKEN_KEY = 'ssot_token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY) ?? '',
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 20000,
});

http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export interface ApiError {
  code?: string;
  message?: string;
  errors?: {
    formErrors?: string[];
    fieldErrors?: Record<string, string[]>;
  };
}

http.interceptors.response.use(
  (res) => res.data,
  (err: AxiosError<ApiError>) => {
    const status = err.response?.status;
    const data = err.response?.data;
    let msg = data?.message || err.message || '请求失败';

    // 401：token 缺失/过期 → 清空并回登录页（登录接口自身除外）
    if (status === 401) {
      tokenStore.clear();
      if (!location.pathname.startsWith('/admin/login')) {
        ElMessage.warning('登录已失效，请重新登录');
        location.href = '/admin/login';
      }
      return Promise.reject(data ?? err);
    }

    // 把服务端 Zod 校验错误摊平展示
    const fieldErrors = data?.errors?.fieldErrors;
    if (fieldErrors) {
      const detail = Object.entries(fieldErrors)
        .map(([key, msgs]) => `${key}: ${msgs.join('；')}`)
        .join(' | ');
      if (detail) msg = `${msg} — ${detail}`;
    }
    ElMessage.error(msg);
    return Promise.reject(data ?? err);
  },
);

export default http;
