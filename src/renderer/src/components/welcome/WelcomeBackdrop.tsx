/**
 * @file WelcomeBackdrop.tsx - Animated background for the welcome screen.
 * @description radial gradient + grid pattern + 4 motion glow orbs. Pure decoration, no business logic.
 */

import { motion } from 'framer-motion';
import type React from 'react';

export const WelcomeBackdrop: React.FC = () => {
  return (
    <div className="welcome-bg-gradient absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 50% at 50% -20%, var(--welcome-glow-primary), transparent)',
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 50% 80% at 100% 50%, var(--welcome-glow-secondary), transparent)',
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 50% 50% at 0% 100%, var(--welcome-glow-primary), transparent)',
          opacity: 0.6,
        }}
      />
      {/* Grid Pattern */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `
            linear-gradient(var(--welcome-grid-color) 1px, transparent 1px),
            linear-gradient(90deg, var(--welcome-grid-color) 1px, transparent 1px)
          `,
          backgroundSize: '50px 50px',
        }}
      />
      {/* Glow Orbs */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3, duration: 1.2 }}
        className="absolute left-[20%] top-[15%] h-[500px] w-[500px] rounded-full blur-[150px]"
        style={{
          background: 'radial-gradient(circle, var(--welcome-glow-primary) 0%, transparent 70%)',
        }}
      />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5, duration: 1.5 }}
        className="absolute bottom-[20%] right-[15%] h-[400px] w-[400px] rounded-full blur-[120px]"
        style={{
          background: 'radial-gradient(circle, var(--welcome-glow-secondary) 0%, transparent 70%)',
        }}
      />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.7, duration: 1.8 }}
        className="absolute left-[10%] top-[60%] h-[300px] w-[300px] rounded-full blur-[100px]"
        style={{
          background: 'radial-gradient(circle, var(--welcome-glow-primary) 0%, transparent 70%)',
          opacity: 0.7,
        }}
      />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.9, duration: 2 }}
        className="absolute right-[25%] top-[10%] h-[250px] w-[250px] rounded-full blur-[80px]"
        style={{
          background: 'radial-gradient(circle, var(--welcome-glow-secondary) 0%, transparent 70%)',
          opacity: 0.5,
        }}
      />
    </div>
  );
};
