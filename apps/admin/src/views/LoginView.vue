<template>
  <div class="login-page">
    <form class="login-card" @submit.prevent="submit">
      <div class="login-brand">
        <span class="brand-icon"><span></span><span></span><span></span><span></span></span>
        <span class="brand-lines">
          <strong>温州有据</strong>
          <small>WENZHOU · FACTFLOW</small>
        </span>
      </div>

      <div class="eyebrow">OPERATOR ACCESS</div>
      <h2>登录事实工作台</h2>
      <p class="card-desc">新闻进入 Fast Lane，事实经 Fact Lane 抽取与人工审核后，由机器出口统一发布。</p>

      <label class="field">
        <span>用户名</span>
        <input
          v-model="form.username"
          type="text"
          placeholder="请输入用户名"
          autocomplete="username"
          :disabled="loading"
        />
        <small v-if="err.username" class="field-err">{{ err.username }}</small>
      </label>

      <label class="field">
        <span>密码</span>
        <input
          v-model="form.password"
          type="password"
          placeholder="请输入密码"
          autocomplete="current-password"
          :disabled="loading"
        />
        <small v-if="err.password" class="field-err">{{ err.password }}</small>
      </label>

      <button class="login-btn" type="submit" :disabled="loading">
        {{ loading ? '登录中…' : '登 录' }}
      </button>

      <div class="service-note">
        <span class="service-beacon"></span>已连接 SSOT 生产接口 · 实时数据
      </div>
      <div class="card-foot">温州市新闻传媒中心 · 城市可信内容枢纽</div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { authApi } from '@/api';
import { tokenStore } from '@/api/http';

const router = useRouter();
const loading = ref(false);

const form = reactive({
  username: '',
  password: '',
});

const err = reactive({
  username: '',
  password: '',
});

const submit = async () => {
  err.username = form.username.trim() ? '' : '请输入用户名';
  err.password = form.password ? '' : '请输入密码';
  if (err.username || err.password) return;
  loading.value = true;
  try {
    const res = await authApi.login({ username: form.username, password: form.password });
    tokenStore.set(res.token);
    router.replace((router.currentRoute.value.query.redirect as string) || '/');
  } finally {
    loading.value = false;
  }
};
</script>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 34px 20px;
  background:
    radial-gradient(circle at 76% 45%, #20576a 0%, transparent 38%),
    linear-gradient(110deg, #0a273e 0%, #0d3950 65%, #12465c 100%);
}

.login-card {
  width: min(392px, 100%);
  padding: 32px 34px 24px;
  background: #fff;
  border-radius: 15px;
  box-shadow: 0 25px 65px #0417274a;
  color: #152c3c;
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 13px;
  margin-bottom: 24px;
}
.brand-icon {
  display: grid;
  grid-template-columns: repeat(2, 12px);
  grid-template-rows: repeat(2, 12px);
  gap: 4px;
  transform: rotate(-15deg);
}
.brand-icon span {
  border-radius: 3px;
}
.brand-icon span:nth-child(1) {
  background: #6ed0ba;
}
.brand-icon span:nth-child(2) {
  background: #f4be7d;
}
.brand-icon span:nth-child(3) {
  background: #b7dfd7;
}
.brand-icon span:nth-child(4) {
  background: #4faab8;
}
.brand-lines {
  display: flex;
  flex-direction: column;
}
.brand-lines strong {
  font-size: 19px;
  font-weight: 750;
  letter-spacing: 0.8px;
  color: #0a2034;
}
.brand-lines small {
  margin-top: 4px;
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 1.65px;
  color: #87a9bf;
}

.eyebrow {
  margin: 0 0 6px;
  font-size: 9.5px;
  font-weight: 800;
  letter-spacing: 1.8px;
  color: #3e9d94;
}
.login-card h2 {
  margin: 0 0 8px;
  font-size: 21px;
  font-weight: 750;
  color: #152c3c;
}
.card-desc {
  margin: 0 0 20px;
  font-size: 11.5px;
  line-height: 1.8;
  color: #81919d;
}

.field {
  display: block;
  margin-bottom: 15px;
}
.field > span {
  display: block;
  margin-bottom: 7px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: #5a7386;
}
.field input {
  width: 100%;
  min-height: 42px;
  padding: 0 13px;
  font-size: 12.5px;
  color: #253b4b;
  background: #fff;
  border: 1px solid #dfe7ed;
  border-radius: 9px;
  outline: 0;
  transition: 0.15s;
}
.field input::placeholder {
  color: #a8b5bf;
}
.field input:focus {
  border-color: #9fd0c9;
  box-shadow: 0 0 0 3px #13857714;
}
.field input:disabled {
  background: #f5f7fa;
}
.field-err {
  display: block;
  margin-top: 6px;
  font-size: 10px;
  color: #c05a4a;
}

.login-btn {
  width: 100%;
  min-height: 44px;
  margin-top: 5px;
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #fff;
  background: #168774;
  border: 1px solid #168774;
  border-radius: 9px;
  cursor: pointer;
  transition: 0.15s;
}
.login-btn:hover:not(:disabled) {
  background: #137a69;
  transform: translateY(-1px);
}
.login-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.service-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
  font-size: 10px;
  color: #366e66;
}
.service-beacon {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #23b68c;
  box-shadow: 0 0 0 4px rgba(35, 182, 140, 0.13);
}

.card-foot {
  margin-top: 14px;
  padding-top: 13px;
  border-top: 1px solid #eef2f4;
  font-size: 10px;
  color: #9aacb7;
  text-align: center;
}
</style>
