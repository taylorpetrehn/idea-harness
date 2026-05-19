/**
 * Dependency-free markdown-lite renderer for idea.md bodies. The body is
 * the primary triage artifact; rendering it as one raw monospace blob
 * (the previous behaviour) buries the structure. This handles the subset
 * the harness actually emits: ATX headings, `-`/`*`/`1.` lists, fenced
 * code blocks, `> ` quotes, `**bold**` and `` `code` `` inline, and
 * blank-line paragraph breaks. No npm dependency — safe on SDK 55.
 */

import { Fragment } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, monoFont, radius, space } from '../lib/theme';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'ordered'; marker: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'para'; text: string };

function parse(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ kind: 'para', text: para.join(' ').trim() });
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^\s*```/)) {
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^\s*```/)) buf.push(lines[i++]);
      blocks.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flush();
      blocks.push({ kind: 'bullet', text: bullet[1] });
      continue;
    }
    const ordered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ordered) {
      flush();
      blocks.push({ kind: 'ordered', marker: ordered[1], text: ordered[2] });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flush();
      blocks.push({ kind: 'quote', text: quote[1] });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    // Soft-wrapped continuation of a list item (no blank line since the
    // bullet) — fold it into that item instead of orphaning a paragraph.
    const last = blocks[blocks.length - 1];
    if (para.length === 0 && last && (last.kind === 'bullet' || last.kind === 'ordered')) {
      last.text += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

// Inline: split on `**bold**` and `` `code` ``.
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, idx) => {
        if (p.match(/^\*\*[^*]+\*\*$/)) {
          return (
            <Text key={idx} style={styles.bold}>
              {p.slice(2, -2)}
            </Text>
          );
        }
        if (p.match(/^`[^`]+`$/)) {
          return (
            <Text key={idx} style={styles.codeInline}>
              {p.slice(1, -1)}
            </Text>
          );
        }
        return <Fragment key={idx}>{p}</Fragment>;
      })}
    </>
  );
}

export function Markdown({ children }: { children: string }) {
  const blocks = parse(children || '');
  if (blocks.length === 0) {
    return <Text style={styles.empty}>(empty body)</Text>;
  }
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return (
              <Text
                key={i}
                style={[styles.heading, b.level <= 1 ? styles.h1 : b.level === 2 ? styles.h2 : styles.h3]}
                accessibilityRole="header"
              >
                <Inline text={b.text} />
              </Text>
            );
          case 'bullet':
            return (
              <View key={i} style={styles.li}>
                <Text style={styles.bulletDot}>•</Text>
                <Text style={styles.liText}>
                  <Inline text={b.text} />
                </Text>
              </View>
            );
          case 'ordered':
            return (
              <View key={i} style={styles.li}>
                <Text style={styles.bulletDot}>{b.marker}.</Text>
                <Text style={styles.liText}>
                  <Inline text={b.text} />
                </Text>
              </View>
            );
          case 'quote':
            return (
              <View key={i} style={styles.quote}>
                <Text style={styles.quoteText}>
                  <Inline text={b.text} />
                </Text>
              </View>
            );
          case 'code':
            return (
              <View key={i} style={styles.codeBlock}>
                <Text style={styles.codeText}>{b.text}</Text>
              </View>
            );
          default:
            return (
              <Text key={i} style={styles.para}>
                <Inline text={b.text} />
              </Text>
            );
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.sm },
  empty: { color: colors.textMuted, fontStyle: 'italic' },
  heading: { color: colors.textPrimary, fontWeight: '700', marginTop: space.sm },
  h1: { fontSize: 19 },
  h2: { fontSize: 16 },
  h3: { fontSize: 14, color: colors.accent, textTransform: 'uppercase', letterSpacing: 0.5 },
  para: { color: '#cbd5e1', fontSize: 14, lineHeight: 22 },
  bold: { fontWeight: '700', color: colors.textPrimary },
  li: { flexDirection: 'row', gap: space.sm, paddingLeft: space.xs },
  bulletDot: { color: colors.accent, fontSize: 14, lineHeight: 22, width: 18 },
  liText: { color: '#cbd5e1', fontSize: 14, lineHeight: 22, flex: 1 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: space.md },
  quoteText: { color: colors.textSecondary, fontSize: 14, lineHeight: 22, fontStyle: 'italic' },
  codeInline: {
    fontFamily: monoFont,
    fontSize: 13,
    color: '#e2e8f0',
    backgroundColor: colors.surfaceAlt,
  },
  codeBlock: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  codeText: { fontFamily: monoFont, fontSize: 13, color: '#e2e8f0', lineHeight: 19 },
});
