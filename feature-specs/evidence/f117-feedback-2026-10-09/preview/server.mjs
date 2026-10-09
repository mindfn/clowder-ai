import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { createServer } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(root, '../../../../packages/web');
const api = `export const API_URL=''; export async function apiFetch(path,init={}) { window.fixtureRequests.push({path,body:init.body}); let body={}; if(path==='/api/cats')body={cats:window.fixtureCats}; else if(path==='/api/config')body={config:{coCreator:{name:'lang',aliases:[],mentionPatterns:['@lang']}}}; else if(path.includes('message-disposition'))body={productDefault:'next_work',global:'continue_current',thread:null,effective:'continue_current',source:'global'}; else if(path.includes('/executions/live/') && init.method==='POST'){const id=decodeURIComponent(path.split('/executions/live/')[1].split('/')[0]);window.fixtureExecutions=window.fixtureExecutions.filter(e=>e.executionId!==id);} else if(path.includes('/api/executions/active'))body={projectPath:'/fixture',executions:window.fixtureExecutions}; return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}}); }`;
const server = await createServer({
  root,
  configFile: false,
  server: {
    host: '127.0.0.1',
    port: Number(process.argv[2]),
    strictPort: true,
    fs: { allow: [path.resolve(web, '../..')] },
  },
  resolve: {
    alias: [
      { find: '@/utils/api-client', replacement: 'virtual:fixture-api' },
      { find: 'next/navigation', replacement: 'virtual:fixture-nav' },
      { find: '@', replacement: path.join(web, 'src') },
      { find: '@ricky0123/vad-web', replacement: path.join(web, 'src/__mocks__/vad-web.ts') },
    ],
  },
  plugins: [
    {
      name: 'in-memory-preview-api',
      resolveId(id) {
        if (id.startsWith('virtual:fixture-')) return '\0' + id;
      },
      load(id) {
        if (id === '\0virtual:fixture-api') return api;
        if (id === '\0virtual:fixture-nav')
          return 'export const useRouter=()=>({push(){}}); export const usePathname=()=>"/fixture"; export const useSearchParams=()=>new URLSearchParams();';
      },
    },
  ],
  define: { 'process.env': '{}' },
  esbuild: { jsx: 'automatic' },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          ...createRequire(import.meta.url)(path.join(web, 'tailwind.config.js')),
          content: [path.join(web, 'src/**/*.{js,ts,jsx,tsx,mdx}')],
        }),
        autoprefixer(),
      ],
    },
  },
});
await server.listen();
console.log(server.resolvedUrls.local[0]);
