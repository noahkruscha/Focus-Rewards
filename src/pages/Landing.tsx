import { motion } from "framer-motion";
import { ArrowRight, CheckCircle2, Coins, Film, LockKeyhole, Play, Sparkles, Timer, WalletCards, Zap } from "lucide-react";
import { Link } from "react-router";

export default function Landing() {
  return (
    <div className="landing-shell">
      <header className="landing-nav">
        <a className="brand-lockup" href="/" aria-label="Focus Rewards home">
          <span className="brand-mark"><Zap size={17} fill="currentColor" /></span>
          <span>Focus Rewards<span className="brand-period">.</span></span>
        </a>
        <div className="landing-nav-links"><Link className="landing-signin-link" to="/auth">Sign in</Link><Link className="landing-nav-action" to="/auth">Get started <ArrowRight size={13} /></Link></div>
      </header>
      <main className="landing-main">
        <motion.section className="landing-copy" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .6 }}>
          <span className="landing-eyebrow"><i /> YOUR FOCUS, WITH SOMETHING TO LOOK FORWARD TO</span>
          <h1>Focus with<br />a little <span>reward.</span></h1>
          <p>Make room for meaningful work. Earn coins as you focus and finish tasks, then spend them on a well-earned entertainment break.</p>
          <div className="landing-actions">
            <Link className="landing-cta" to="/auth">Create your personal space <ArrowRight size={15} /></Link>
          </div>
          <div className="landing-trust"><LockKeyhole size={14} /> Designed for one: you. Your personal data stays on this device.</div>
          <Link className="landing-account-note" to="/auth">Already have an account? <span>Sign in <ArrowRight size={12} /></span></Link>
        </motion.section>
        <motion.div className="landing-preview-wrap" initial={{ opacity: 0, scale: .96, x: 12 }} animate={{ opacity: 1, scale: 1, x: 0 }} transition={{ duration: .65, delay: .12 }}>
          <div className="landing-glow" />
          <div className="landing-preview" aria-label="Focus Rewards personal dashboard preview">
            <div className="preview-top"><span>YOUR FOCUS REWARDS</span><span className="preview-coins"><Coins size={13} /> 240</span></div>
            <div className="preview-summary">
              <div className="preview-tile"><span>FOCUS TODAY</span><strong>65 <small>min</small></strong></div>
              <div className="preview-tile"><span>DAILY PROGRESS</span><strong>54<small>%</small></strong></div>
            </div>
            <div className="preview-focus">
              <span className="preview-focus-label">YOUR NEXT FOCUS SESSION</span>
              <div className="preview-timer">24:18</div>
              <span className="preview-activity">Coding <span>·</span> One thing at a time</span>
              <div className="preview-button"><Play size={12} fill="currentColor" /> Start a focus session</div>
            </div>
            <div className="preview-reward"><span><Sparkles size={12} /> SESSION COIN PREVIEW</span><strong>+8 coins</strong></div>
          </div>
        </motion.div>
      </main>
      <section className="landing-principle" id="how-it-works">
        <div><span><Timer size={14} /></span><strong>Make focus count</strong><p>Build a steady habit with a thoughtful timer and coins that reward your time.</p></div>
        <div><span><CheckCircle2 size={14} /></span><strong>Celebrate small wins</strong><p>Finish your tasks for a one-time bonus. Keep an eye on your progress.</p></div>
        <div><span><Film size={14} /></span><strong>Enjoy what you earn</strong><p>Browse original sample rewards and unlock them with your focus coins.</p></div>
        <div><span><WalletCards size={14} /></span><strong>Keep it personal</strong><p>Your tasks, rewards and session history live locally in your browser.</p></div>
      </section>
      <footer className="landing-footer"><span>Focus Rewards <span className="brand-period">·</span> focus first, enjoy it after</span><span>Made for your own pace.</span></footer>
    </div>
  );
}
