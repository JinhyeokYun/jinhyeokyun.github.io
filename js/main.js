/* ============================================
   PORTFOLIO — 윤진혁 (Jinhyeok Yun)
   Main JavaScript
   ============================================ */

document.addEventListener('DOMContentLoaded', () => {

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

    function onMediaChange(query, handler) {
        if (query.addEventListener) {
            query.addEventListener('change', handler);
        } else {
            query.addListener(handler);
        }
    }

    // --- Navbar Scroll Effect & Active Section ---
    const navbar = document.getElementById('navbar');
    const navLinks = document.querySelectorAll('.nav-link');
    const hashLinks = Array.from(navLinks).filter(link => (link.getAttribute('href') || '').startsWith('#'));
    const sections = Array.from(document.querySelectorAll('section[id], footer[id]'))
        .filter(section => hashLinks.some(link => link.getAttribute('href') === `#${section.id}`));

    function handleNavScroll() {
        if (navbar) {
            navbar.classList.toggle('scrolled', window.scrollY > 16);
        }
    }

    function setActiveLink(id) {
        hashLinks.forEach(link => {
            link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
        });
    }

    function updateActiveNav() {
        if (!sections.length) return;

        const doc = document.documentElement;
        const atBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 2;
        let currentId = null;

        if (atBottom) {
            currentId = sections[sections.length - 1].id;
        } else {
            const probe = window.scrollY + (navbar ? navbar.offsetHeight : 64) + 56;
            sections.forEach(section => {
                if (probe >= section.offsetTop) {
                    currentId = section.id;
                }
            });
        }

        if (currentId) {
            setActiveLink(currentId);
        }
    }

    let scrollTicking = false;
    function onScroll() {
        if (scrollTicking) return;
        scrollTicking = true;
        window.requestAnimationFrame(() => {
            handleNavScroll();
            updateActiveNav();
            scrollTicking = false;
        });
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    // --- Mobile Nav Toggle ---
    const navToggle = document.getElementById('navToggle');
    const navMenu = document.getElementById('navLinks');

    if (navToggle && navMenu) {
        navToggle.setAttribute('aria-controls', 'navLinks');
        navToggle.setAttribute('aria-expanded', 'false');

        const setMenu = open => {
            navMenu.classList.toggle('open', open);
            navToggle.classList.toggle('active', open);
            navToggle.setAttribute('aria-expanded', String(open));
        };

        navToggle.addEventListener('click', () => {
            setMenu(!navMenu.classList.contains('open'));
        });

        navLinks.forEach(link => {
            link.addEventListener('click', () => setMenu(false));
        });

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && navMenu.classList.contains('open')) {
                setMenu(false);
                navToggle.focus();
            }
        });
    }

    // --- Presentations: show the first few per column, expand on demand ---
    const PRES_VISIBLE = 5;

    document.querySelectorAll('.pres-column').forEach((column, index) => {
        const list = column.querySelector('.pres-list');
        if (!list) return;

        const cards = list.querySelectorAll('.pres-card');
        if (cards.length <= PRES_VISIBLE) return;

        const hiddenCount = cards.length - PRES_VISIBLE;
        cards.forEach((card, i) => {
            if (i >= PRES_VISIBLE) card.classList.add('is-extra');
        });

        if (!list.id) list.id = `pres-list-${index + 1}`;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pres-more';
        button.setAttribute('aria-controls', list.id);

        const render = collapsed => {
            column.classList.toggle('is-collapsed', collapsed);
            button.setAttribute('aria-expanded', String(!collapsed));
            button.textContent = collapsed ? `더 보기 (+${hiddenCount})` : '접기';
        };

        button.addEventListener('click', () => {
            const collapse = !column.classList.contains('is-collapsed');
            render(collapse);
            if (collapse) {
                column.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
            }
        });

        list.after(button);
        render(true);
    });

    // --- Fade-in on scroll (skipped for reduced motion; content stays visible without JS) ---
    const fadeSelector = '.research-card, .pub-item, .timeline-item, .highlight-block, .pres-card, .edu-item, .skill-group';

    if (!reducedMotion.matches && 'IntersectionObserver' in window) {
        const fadeObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;

                const el = entry.target;
                el.classList.add('visible');
                fadeObserver.unobserve(el);

                // Drop the fade classes afterwards so hover transitions are not delayed
                window.setTimeout(() => {
                    el.classList.remove('fade-in', 'visible');
                    el.style.removeProperty('--fade-delay');
                }, 900);
            });
        }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

        document.querySelectorAll(fadeSelector).forEach(el => {
            const siblings = el.parentElement ? Array.from(el.parentElement.children) : [el];
            const order = Math.max(0, siblings.indexOf(el)) % 4;
            el.style.setProperty('--fade-delay', `${order * 60}ms`);
            el.classList.add('fade-in');
            fadeObserver.observe(el);
        });
    }

    // --- Hero Canvas: CFD-inspired Mesh Pattern ---
    const canvas = document.getElementById('heroCanvas');
    if (canvas && canvas.getContext) {
        const ctx = canvas.getContext('2d');
        const mobileViewport = window.matchMedia('(max-width: 768px)');
        let animationFrame = null;
        let canvasWidth = 0;
        let canvasHeight = 0;
        let heroVisible = true;
        let particles = [];
        let colors = readColors();

        function readColors() {
            const styles = getComputedStyle(document.documentElement);
            return {
                line: styles.getPropertyValue('--canvas-line').trim() || '#17365D',
                dot: styles.getPropertyValue('--canvas-dot').trim() || '#0E7C77'
            };
        }

        function getCanvasConfig() {
            return mobileViewport.matches
                ? { particleCount: 22, connectionDistance: 90, dprCap: 1.5 }
                : { particleCount: 56, connectionDistance: 150, dprCap: 2 };
        }

        function stopAnimation() {
            if (animationFrame) {
                cancelAnimationFrame(animationFrame);
                animationFrame = null;
            }
        }

        function resizeCanvas() {
            const rect = canvas.getBoundingClientRect();
            const { dprCap } = getCanvasConfig();
            const dpr = Math.min(window.devicePixelRatio || 1, dprCap);

            canvasWidth = rect.width;
            canvasHeight = rect.height;
            canvas.width = Math.max(1, Math.round(rect.width * dpr));
            canvas.height = Math.max(1, Math.round(rect.height * dpr));
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        function createParticles() {
            const { particleCount } = getCanvasConfig();
            particles = [];
            for (let i = 0; i < particleCount; i++) {
                particles.push({
                    x: Math.random() * canvasWidth,
                    y: Math.random() * canvasHeight,
                    vx: (Math.random() - 0.5) * 0.5,
                    vy: (Math.random() - 0.5) * 0.3,
                    radius: Math.random() * 2 + 1,
                    opacity: Math.random() * 0.5 + 0.1
                });
            }
        }

        function drawParticles(animate = true) {
            const { connectionDistance } = getCanvasConfig();
            ctx.clearRect(0, 0, canvasWidth, canvasHeight);

            // Connections
            ctx.strokeStyle = colors.line;
            ctx.lineWidth = 0.5;
            for (let i = 0; i < particles.length; i++) {
                for (let j = i + 1; j < particles.length; j++) {
                    const dx = particles[i].x - particles[j].x;
                    const dy = particles[i].y - particles[j].y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < connectionDistance) {
                        ctx.globalAlpha = (1 - dist / connectionDistance) * 0.18;
                        ctx.beginPath();
                        ctx.moveTo(particles[i].x, particles[i].y);
                        ctx.lineTo(particles[j].x, particles[j].y);
                        ctx.stroke();
                    }
                }
            }

            // Particles
            ctx.fillStyle = colors.dot;
            particles.forEach(p => {
                ctx.globalAlpha = p.opacity;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                ctx.fill();

                if (!animate) return;

                p.x += p.vx;
                p.y += p.vy;

                if (p.x < 0 || p.x > canvasWidth) p.vx *= -1;
                if (p.y < 0 || p.y > canvasHeight) p.vy *= -1;
            });
            ctx.globalAlpha = 1;

            if (animate) {
                animationFrame = requestAnimationFrame(() => drawParticles(true));
            }
        }

        function refreshCanvas(recreate = true) {
            stopAnimation();
            resizeCanvas();

            if (recreate || !particles.length) {
                createParticles();
            } else {
                particles.forEach(p => {
                    p.x = Math.min(p.x, canvasWidth);
                    p.y = Math.min(p.y, canvasHeight);
                });
            }

            if (reducedMotion.matches || !heroVisible) {
                drawParticles(false);
                return;
            }

            drawParticles(true);
        }

        refreshCanvas();

        // Rebuild particles only when the width changes (mobile URL bars change the height)
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(() => {
                const width = canvas.getBoundingClientRect().width;
                refreshCanvas(Math.abs(width - canvasWidth) > 1);
            }, 150);
        }, { passive: true });

        // Pause animation when the hero is off screen
        const heroSection = document.getElementById('hero');
        if (heroSection && 'IntersectionObserver' in window) {
            const heroObserver = new IntersectionObserver(entries => {
                entries.forEach(entry => {
                    heroVisible = entry.isIntersecting;

                    if (!heroVisible) {
                        stopAnimation();
                        return;
                    }

                    if (reducedMotion.matches) {
                        drawParticles(false);
                        return;
                    }

                    if (!animationFrame) {
                        drawParticles(true);
                    }
                });
            }, { threshold: 0.1 });

            heroObserver.observe(heroSection);
        }

        onMediaChange(mobileViewport, () => refreshCanvas(true));
        onMediaChange(reducedMotion, () => refreshCanvas(false));
        onMediaChange(darkScheme, () => {
            colors = readColors();
            if (!animationFrame) drawParticles(false);
        });
    }

    // --- Result videos: play only while visible, never with reduced motion ---
    const autoVideos = document.querySelectorAll('video[data-autoplay]');
    if (autoVideos.length) {
        const noMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const syncVideo = (video, visible) => {
            if (noMotion.matches) {
                video.pause();
                video.controls = true;
                return;
            }
            video.controls = false;
            if (visible) {
                video.preload = 'auto';
                const p = video.play();
                if (p && p.catch) p.catch(() => { video.controls = true; });
            } else {
                video.pause();
            }
        };
        if ('IntersectionObserver' in window) {
            const videoObserver = new IntersectionObserver(entries => {
                entries.forEach(entry => syncVideo(entry.target, entry.isIntersecting));
            }, { threshold: 0.25 });
            autoVideos.forEach(v => videoObserver.observe(v));
        } else {
            autoVideos.forEach(v => syncVideo(v, true));
        }
        onMediaChange(noMotion, () => autoVideos.forEach(v => syncVideo(v, false)));
    }

    // --- Initial state ---
    handleNavScroll();
    updateActiveNav();
});
