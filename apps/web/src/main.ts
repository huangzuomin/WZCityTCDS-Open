import { createApp } from 'vue';
import './styles/tokens.css';
import './styles/global.css';

import App from './App.vue';
import router from './router';

/**
 * 公开前台入口：无登录、无权限 UI、不引 Element Plus。
 * 只承载语料首页 / 档案页 / 公开图谱三类只读页面。
 */
const app = createApp(App);
app.use(router);
app.mount('#app');
