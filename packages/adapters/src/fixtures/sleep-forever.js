// Portable fixture: a process that never exits on its own — the grandchild
// target for `hang-with-grandchild.js`. Only dies if killed.
setInterval(() => {}, 1000);
