import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Download, ExternalLink, Play } from 'lucide-react';
import presentation from './presentation.json';
import '../styles/deck.css';

const slides = presentation.slides;

function indexFromHash() {
  const number = Number(window.location.hash.slice(1));
  return Number.isInteger(number) && number >= 1 && number <= slides.length ? number - 1 : 0;
}

function showSlide(index: number) {
  const next = Math.max(0, Math.min(slides.length - 1, index));
  window.location.hash = String(next + 1);
}

/** The web viewer and submission PDF use the same official-template slide renders. */
export function Deck() {
  const [index, setIndex] = useState(indexFromHash);
  const slide = slides[index];

  useEffect(() => {
    const sync = () => setIndex(indexFromHash());
    window.addEventListener('hashchange', sync);
    if (!window.location.hash) window.history.replaceState(null, '', '#1');
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, select, textarea, button, a, summary, [contenteditable="true"]')) return;
      const destination = {
        ArrowRight: index + 1, PageDown: index + 1, ' ': index + 1,
        ArrowLeft: index - 1, PageUp: index - 1, Home: 0, End: slides.length - 1,
      }[event.key];
      if (destination === undefined) return;
      event.preventDefault();
      showSlide(destination);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index]);

  return (
    <div className="submission-deck" data-deck-version={presentation.version}>
      <header className="submission-deck-header">
        <div>
          <a className="deck-home" href="/">TwinOps <span>/ HackSmith</span></a>
          <h1>Submission presentation</h1>
          <p>The same 13 slides as the official-template PDF.</p>
        </div>
        <div className="submission-deck-links">
          <a href={presentation.videoUrl}><Play size={16} aria-hidden="true" /> Watch 3-minute demo</a>
          <a href={presentation.pdfUrl}><Download size={16} aria-hidden="true" /> Download submission PDF</a>
        </div>
      </header>
      <main id="main" className="submission-deck-main">
        <section className="submission-deck-slide" role="region" aria-label={`${index + 1} of ${slides.length}: ${slide.title}`}>
          <a className="deck-image-link" href={slide.image} target="_blank" rel="noreferrer" aria-label={`Open full-size slide ${index + 1}: ${slide.title}`}>
            <img key={slide.image} src={slide.image} width={2400} height={1350} alt={slide.alt} fetchPriority="high" />
          </a>
        </section>
        <nav className="submission-deck-controls" aria-label="Slides">
          <button type="button" onClick={() => showSlide(index - 1)} disabled={index === 0} aria-label="Previous slide"><ArrowLeft size={18} aria-hidden="true" /> Previous</button>
          <label className="deck-slide-picker">
            <span className="sr-only">Choose a slide</span>
            <select value={index} onChange={(event) => showSlide(Number(event.target.value))}>
              {slides.map((item, i) => <option key={item.number} value={i}>{item.number} / {slides.length} · {item.title}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => showSlide(index + 1)} disabled={index === slides.length - 1} aria-label="Next slide">Next <ArrowRight size={18} aria-hidden="true" /></button>
          <span className="sr-only" aria-live="polite">Slide {index + 1} of {slides.length}: {slide.title}</span>
        </nav>
        <p className="deck-keyboard-hint">Use the arrow keys to navigate. Select the slide image to open it at full size.</p>
        <section className="deck-reading" aria-labelledby="deck-reading-title">
          <h2 id="deck-reading-title">{slide.title}</h2>
          {slide.paragraphs.map((paragraph, i) => <p key={i}>{paragraph}</p>)}
          {slide.links.length > 0 && <ul>{slide.links.map((link) => <li key={link.url}><a href={link.url}>{link.label} <ExternalLink size={14} aria-hidden="true" /></a></li>)}</ul>}
        </section>
      </main>
      <footer className="submission-deck-footer">
        <p>Recorded evidence: 15 October 2026. Synthetic network prototype; production reliability and time savings remain unvalidated.</p>
        <a href="/workbench">Open workbench</a>
        <a href={presentation.pptxUrl}>Editable PowerPoint</a>
      </footer>
    </div>
  );
}
