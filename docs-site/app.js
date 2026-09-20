// Mobile sidebar toggle
(function() {
  const menuToggle = document.getElementById('menu-toggle');
  const sidebar = document.querySelector('.sidebar');
  if (menuToggle && sidebar) {
    menuToggle.addEventListener('click', () => sidebar.classList.toggle('open'));
  }
})();

// Sidebar active link tracking
(function() {
  const navLinks = document.querySelectorAll('.sidebar nav a[href^="#"]');
  const sections = [];
  navLinks.forEach(link => {
    const id = link.getAttribute('href').slice(1);
    const el = document.getElementById(id);
    if (el) sections.push({ id, el, link });
  });

  function updateActive() {
    const scrollY = window.scrollY + 80;
    let current = sections[0];
    for (const s of sections) {
      if (s.el.offsetTop <= scrollY) current = s;
    }
    navLinks.forEach(l => l.classList.remove('active'));
    if (current) current.link.classList.add('active');
  }

  window.addEventListener('scroll', updateActive, { passive: true });
  updateActive();

  // Close mobile sidebar on link click
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      document.querySelector('.sidebar').classList.remove('open');
    });
  });
})();
