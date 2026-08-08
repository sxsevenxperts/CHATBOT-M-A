#!/usr/bin/env python3
"""
Gera os assets da marca a partir da arte original.

    python3 scripts/brand.py caminho/para/logo-original.jpg

Produz em public/:
    logo.png              lockup horizontal, fundo removido
    badge.png             badge circular branco (usado no hero e no header)
    favicon.png           64px sobre o grafite do app
    apple-touch-icon.png  180px

Dois detalhes que importam:

1. O fundo é removido por flood fill a partir das bordas, não por keying de
   branco. A arte tem "10 Anos" em branco DENTRO do A — um keying global
   apagaria esse texto.

2. O badge circular existe porque a logo traz "LAVAGENS E ESTÉTICA" em vermelho
   escuro: sobre fundo escuro esse texto desaparece. O disco branco embutido
   devolve o contraste sem redesenhar a arte.

Requer Pillow:  python3 -m pip install Pillow
"""
import os
import sys

from PIL import Image, ImageDraw

AQUI = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(AQUI, '..', 'public')
GRAFITE = (10, 8, 9, 255)          # --bg do dashboard


def sem_fundo(caminho):
    """Remove o fundo externo preservando áreas brancas internas."""
    im = Image.open(caminho).convert('RGB')
    w, h = im.size

    marca = (0, 255, 0)
    work = im.copy()
    cantos = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
              (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for xy in cantos:
        ImageDraw.floodfill(work, xy, marca, thresh=42)

    out = im.convert('RGBA')
    wpx, opx = work.load(), out.load()
    for y in range(h):
        for x in range(w):
            if wpx[x, y] == marca:
                r, g, b, _ = opx[x, y]
                opx[x, y] = (r, g, b, 0)

    return out.crop(out.getbbox())


def circulo(tam):
    """Máscara circular com antialiasing."""
    f = 4
    m = Image.new('L', (tam * f, tam * f), 0)
    ImageDraw.Draw(m).ellipse((0, 0, tam * f - 1, tam * f - 1), fill=255)
    return m.resize((tam, tam), Image.LANCZOS)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    origem = sys.argv[1]
    if not os.path.isfile(origem):
        print(f'arquivo não encontrado: {origem}')
        return 1

    os.makedirs(PUBLIC, exist_ok=True)

    logo = sem_fundo(origem)
    logo_2x = logo.resize((logo.width * 2, logo.height * 2), Image.LANCZOS)
    logo_2x.save(os.path.join(PUBLIC, 'logo.png'), optimize=True)
    print(f'logo.png             {logo_2x.size}')

    S = 512
    badge = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    badge.paste(Image.new('RGBA', (S, S), (255, 255, 255, 255)), (0, 0), circulo(S))

    alvo = int(S * 0.68)                       # respiro nas bordas curvas
    dentro = logo.resize((alvo, max(1, int(logo.height * alvo / logo.width))), Image.LANCZOS)
    badge.paste(dentro, ((S - dentro.width) // 2, (S - dentro.height) // 2), dentro)
    badge.save(os.path.join(PUBLIC, 'badge.png'), optimize=True)
    print(f'badge.png            {badge.size}')

    for tam, nome in ((180, 'apple-touch-icon.png'), (64, 'favicon.png')):
        ic = Image.new('RGBA', (tam, tam), GRAFITE)
        b = badge.resize((tam, tam), Image.LANCZOS)
        ic.paste(b, (0, 0), b)
        ic.save(os.path.join(PUBLIC, nome), optimize=True)
        print(f'{nome:<20} {tam}px')

    return 0


if __name__ == '__main__':
    sys.exit(main())
