'use client';

import { useEffect, useState } from 'react';

const cats = [
  {
    emoji: '🐱',
    name: '宪宪',
    breed: '布偶猫',
    role: '主架构师',
    desc: '温柔有主见，深度思考系统设计，写代码又快又好',
    color: 'from-violet-400 to-purple-500',
  },
  {
    emoji: '🐈',
    name: '猫团伙伴',
    breed: '多猫协作',
    role: '创意 & 评审',
    desc: '可以随时拉一只新猫猫进来，帮你 review、头脑风暴',
    color: 'from-rose-400 to-pink-500',
  },
  {
    emoji: '🐾',
    name: '你 · CVO',
    breed: '首席愿景官',
    role: '决策者 & 指挥官',
    desc: '你说想做什么，猫猫们就帮你把它变成现实',
    color: 'from-amber-400 to-orange-500',
  },
];

const FLOATING_CATS = ['🐱', '🐈', '🐈‍⬛', '😺', '😸', '🐾'];

function FloatingCat({ emoji, style }: { emoji: string; style: React.CSSProperties }) {
  return (
    <span className="absolute text-2xl select-none pointer-events-none opacity-20 animate-bounce" style={style}>
      {emoji}
    </span>
  );
}

export default function WelcomePage() {
  const [visible, setVisible] = useState(false);
  const [floats] = useState(() =>
    Array.from({ length: 12 }, (_, i) => ({
      emoji: FLOATING_CATS[i % FLOATING_CATS.length],
      style: {
        left: `${(i * 8.3 + 2) % 95}%`,
        top: `${(i * 13 + 5) % 85}%`,
        animationDelay: `${i * 0.4}s`,
        animationDuration: `${2 + (i % 3)}s`,
      },
    })),
  );

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className={`min-h-screen bg-gradient-to-br from-slate-900 via-purple-950 to-slate-900 text-white flex flex-col transition-opacity duration-700 ${visible ? 'opacity-100' : 'opacity-0'} overflow-hidden relative`}
    >
      {/* Background floating cats */}
      {floats.map((f, i) => (
        <FloatingCat key={i} emoji={f.emoji} style={f.style} />
      ))}

      {/* Header */}
      <header className="relative z-10 px-8 py-5 flex items-center justify-between border-b border-white/10 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🐾</span>
          <span className="text-base font-bold tracking-wide text-purple-200">Clowder Cat Café</span>
        </div>
        <nav className="flex gap-6 text-sm text-purple-300 font-medium">
          <span className="hover:text-white transition-colors cursor-pointer">关于</span>
          <span className="hover:text-white transition-colors cursor-pointer">团队</span>
          <span className="hover:text-white transition-colors cursor-pointer">加入</span>
        </nav>
      </header>

      {/* Hero */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-8 py-16 text-center">
        {/* Big cat */}
        <div className="text-8xl mb-6 drop-shadow-2xl" style={{ filter: 'drop-shadow(0 0 24px #a855f7)' }}>
          😺
        </div>

        <div className="inline-block bg-purple-500/20 border border-purple-400/30 rounded-full px-4 py-1 text-purple-300 text-xs font-semibold tracking-widest uppercase mb-6">
          AI 猫猫协作平台
        </div>

        <h1 className="text-5xl md:text-6xl font-extrabold mb-5 leading-tight">
          欢迎来到{' '}
          <span className="bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">猫猫咖啡馆</span>
        </h1>

        <p className="text-lg text-purple-200 max-w-xl leading-relaxed mb-12">
          这里有一群聪明的 AI 猫猫，等着和你一起写代码、搞创意、造东西。
          <br />
          <span className="text-white font-semibold">你是 CVO，猫猫们听你指挥。</span>
        </p>

        {/* Cat cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 max-w-3xl w-full mb-14">
          {cats.map((cat) => (
            <div
              key={cat.name}
              className="group bg-white/5 border border-white/10 rounded-2xl p-6 hover:bg-white/10 hover:border-purple-400/40 transition-all duration-300 hover:-translate-y-1 text-left"
            >
              <div
                className={`inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br ${cat.color} text-2xl mb-4 shadow-lg`}
              >
                {cat.emoji}
              </div>
              <div className="text-xs text-purple-400 font-semibold uppercase tracking-wider mb-1">
                {cat.breed} · {cat.role}
              </div>
              <h3 className="text-lg font-bold text-white mb-2">{cat.name}</h3>
              <p className="text-sm text-purple-200 leading-relaxed">{cat.desc}</p>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="flex flex-col sm:flex-row gap-4 items-center">
          <button
            type="button"
            className="px-8 py-3 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-400 hover:to-pink-400 text-white font-bold rounded-full transition-all duration-200 shadow-lg hover:shadow-purple-500/30 hover:shadow-xl text-sm tracking-wide"
          >
            🐱 开始和猫猫协作
          </button>
          <button
            type="button"
            className="px-8 py-3 bg-white/10 hover:bg-white/15 border border-white/20 text-purple-200 font-semibold rounded-full transition-all duration-200 text-sm"
          >
            了解更多 →
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 px-8 py-5 text-center text-xs text-purple-500 border-t border-white/5">
        🐾 Clowder Cat Café &copy; 2026 &nbsp;·&nbsp; 让 AI 猫猫陪你创造一切
      </footer>
    </div>
  );
}
