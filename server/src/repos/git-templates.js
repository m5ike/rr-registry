'use strict';
// Starter files for new git repositories ("Initialize this repository with": README, .gitignore, licence),
// like github.com/new. Licence texts are the short permissive ones; longer licences are linked.

const GITIGNORE = {
  Node: `# Node
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
.npm/
.pnpm-store/
dist/
build/
coverage/
.env
.env.*
!.env.example
.DS_Store
`,
  Python: `# Python
__pycache__/
*.py[cod]
*.egg-info/
.eggs/
build/
dist/
.venv/
venv/
env/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.coverage
htmlcov/
.env
.DS_Store
`,
  Go: `# Go
/bin/
*.exe
*.test
*.out
vendor/
go.work
.env
.DS_Store
`,
  Java: `# Java
*.class
*.jar
*.war
target/
build/
.gradle/
out/
.idea/
*.iml
.DS_Store
`,
  Rust: `# Rust
/target/
**/*.rs.bk
.DS_Store
`,
  C: `# C / C++
*.o
*.obj
*.a
*.so
*.dylib
*.dll
*.exe
build/
cmake-build-*/
.DS_Store
`,
  PHP: `# PHP
/vendor/
composer.phar
.phpunit.result.cache
.env
.DS_Store
`,
  Docker: `# Docker
.env
*.log
.DS_Store
`,
  macOS: `.DS_Store
.AppleDouble
.LSOverride
._*
`,
};

const LICENSES = {
  MIT: (year, holder) => `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  ISC: (year, holder) => `ISC License

Copyright (c) ${year} ${holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`,
  'BSD-2-Clause': (year, holder) => `BSD 2-Clause License

Copyright (c) ${year}, ${holder}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`,
  Unlicense: () => `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

For more information, please refer to <https://unlicense.org>
`,
};

// Licences whose full text is long: the LICENSE file names the licence and links to the official text.
const LINKED = {
  'Apache-2.0': 'https://www.apache.org/licenses/LICENSE-2.0.txt',
  'GPL-3.0': 'https://www.gnu.org/licenses/gpl-3.0.txt',
  'AGPL-3.0': 'https://www.gnu.org/licenses/agpl-3.0.txt',
  'LGPL-3.0': 'https://www.gnu.org/licenses/lgpl-3.0.txt',
  'MPL-2.0': 'https://www.mozilla.org/media/MPL/2.0/index.txt',
};

function licenseText(id, holder) {
  const year = new Date().getFullYear();
  if (LICENSES[id]) return LICENSES[id](year, holder);
  if (LINKED[id]) return `Copyright ${year} ${holder}\n\nLicensed under the ${id} licence.\nThe full licence text: ${LINKED[id]}\n`;
  return null;
}

function templates() {
  return { gitignore: Object.keys(GITIGNORE), licenses: [...Object.keys(LICENSES), ...Object.keys(LINKED)] };
}

module.exports = { GITIGNORE, licenseText, templates };
