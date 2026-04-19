'use client';

import { useEffect, useState } from 'react';

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

const STORAGE_KEY = 'cat-cafe-todos';

export default function TodoPage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setTodos(JSON.parse(saved));
    } else {
      setTodos([
        { id: 1, text: '学习 Cat Cafe 协作系统', done: false },
        { id: 2, text: '认识宪宪猫猫', done: true },
        { id: 3, text: '完成第一个项目', done: false },
      ]);
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
    }
  }, [todos, mounted]);

  const addTodo = () => {
    if (!input.trim()) return;
    setTodos([...todos, { id: Date.now(), text: input.trim(), done: false }]);
    setInput('');
  };

  const toggle = (id: number) => {
    setTodos(todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  };

  const remove = (id: number) => {
    setTodos(todos.filter((t) => t.id !== id));
  };

  const doneCount = todos.filter((t) => t.done).length;
  const totalCount = todos.length;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(160deg, #fef9f0 0%, #fde8f5 100%)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '80px',
        paddingBottom: '80px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div
        style={{
          background: '#ffffff',
          borderRadius: '20px',
          padding: '36px',
          width: '480px',
          boxShadow: '0 8px 32px rgba(180, 120, 180, 0.15)',
          border: '1px solid #f0d8f0',
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: '28px', textAlign: 'center' }}>
          <div style={{ fontSize: '40px', marginBottom: '8px' }}>🐾</div>
          <h1
            style={{
              fontSize: '22px',
              fontWeight: '700',
              color: '#5c3d6e',
              margin: 0,
              letterSpacing: '0.5px',
            }}
          >
            猫猫待办清单
          </h1>
          {totalCount > 0 && (
            <p
              style={{
                margin: '8px 0 0',
                fontSize: '13px',
                color: '#b09ac0',
              }}
            >
              {doneCount} / {totalCount} 完成
              {doneCount === totalCount && totalCount > 0 && ' · 全部搞定了！🎉'}
            </p>
          )}
        </div>

        {/* Input */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTodo()}
            placeholder="添加新任务..."
            style={{
              flex: 1,
              padding: '11px 16px',
              border: '2px solid #e8d5f0',
              borderRadius: '12px',
              background: '#fdf8ff',
              fontSize: '15px',
              color: '#3d2a4e',
              outline: 'none',
              transition: 'border-color 0.2s',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = '#b07fd8';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = '#e8d5f0';
            }}
          />
          <button
            onClick={addTodo}
            style={{
              padding: '11px 20px',
              background: 'linear-gradient(135deg, #c97de8, #9b5fc7)',
              color: '#ffffff',
              border: 'none',
              borderRadius: '12px',
              cursor: 'pointer',
              fontSize: '20px',
              lineHeight: 1,
              transition: 'opacity 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '0.85';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '1';
            }}
            title="添加"
          >
            +
          </button>
        </div>

        {/* Todo list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {todos.length === 0 && (
            <div
              style={{
                textAlign: 'center',
                padding: '32px',
                color: '#c5a8d8',
                fontSize: '14px',
              }}
            >
              还没有任务，添加一个试试 🐱
            </div>
          )}
          {todos.map((todo) => (
            <div
              key={todo.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 14px',
                background: todo.done ? '#faf7fc' : '#ffffff',
                border: `1.5px solid ${todo.done ? '#ead5f8' : '#ede0f5'}`,
                borderRadius: '12px',
                transition: 'all 0.15s',
              }}
            >
              {/* Checkbox */}
              <button
                onClick={() => toggle(todo.id)}
                style={{
                  width: '22px',
                  height: '22px',
                  borderRadius: '50%',
                  border: `2px solid ${todo.done ? '#b07fd8' : '#d4b8e8'}`,
                  background: todo.done ? 'linear-gradient(135deg, #c97de8, #9b5fc7)' : 'transparent',
                  cursor: 'pointer',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  fontSize: '12px',
                  padding: 0,
                  transition: 'all 0.2s',
                }}
              >
                {todo.done ? '✓' : ''}
              </button>

              {/* Text */}
              <span
                style={{
                  flex: 1,
                  color: todo.done ? '#b09ac0' : '#3d2a4e',
                  textDecoration: todo.done ? 'line-through' : 'none',
                  fontSize: '15px',
                  lineHeight: '1.4',
                }}
              >
                {todo.text}
              </span>

              {/* Delete */}
              <button
                onClick={() => remove(todo.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#d4b8e8',
                  fontSize: '16px',
                  padding: '2px 4px',
                  borderRadius: '6px',
                  lineHeight: 1,
                  transition: 'color 0.15s',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = '#e07070';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = '#d4b8e8';
                }}
                title="删除"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {/* Footer */}
        {todos.some((t) => t.done) && (
          <button
            onClick={() => setTodos(todos.filter((t) => !t.done))}
            style={{
              marginTop: '16px',
              width: '100%',
              padding: '9px',
              background: 'none',
              border: '1.5px dashed #e8d5f0',
              borderRadius: '10px',
              color: '#c5a8d8',
              fontSize: '13px',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = '#e07070';
              e.currentTarget.style.color = '#e07070';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = '#e8d5f0';
              e.currentTarget.style.color = '#c5a8d8';
            }}
          >
            清除已完成
          </button>
        )}
      </div>
    </div>
  );
}
