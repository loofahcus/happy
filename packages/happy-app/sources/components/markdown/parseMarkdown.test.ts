import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './parseMarkdown';

describe('parseMarkdown', () => {
    it('parses unordered lists across common markdown bullet markers and preserves clickable links', () => {
        const blocks = parseMarkdown([
            '* first item',
            '+ second item with [docs](https://example.com/docs)',
            '- third item with https://example.com/raw.',
        ].join('\n'));

        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.type).toBe('list');

        if (blocks[0]?.type !== 'list') {
            throw new Error('Expected markdown list block');
        }

        expect(blocks[0].items).toHaveLength(3);
        expect(blocks[0].items[1]).toEqual([
            { styles: [], text: 'second item with ', url: null },
            { styles: [], text: 'docs', url: 'https://example.com/docs' },
        ]);
        expect(blocks[0].items[2]).toEqual([
            { styles: [], text: 'third item with ', url: null },
            { styles: [], text: 'https://example.com/raw', url: 'https://example.com/raw' },
            { styles: [], text: '.', url: null },
        ]);
    });

    it('parses standalone markdown image blocks', () => {
        const blocks = parseMarkdown('![Markdown renderable image](data:image/png;base64,abc123)');

        expect(blocks).toEqual([
            {
                type: 'image',
                alt: 'Markdown renderable image',
                url: 'data:image/png;base64,abc123',
            },
        ]);
    });

    it('auto-linkifies bare URLs in text blocks', () => {
        const blocks = parseMarkdown('Visit https://example.com/docs for more.');

        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.type).toBe('text');

        if (blocks[0]?.type !== 'text') {
            throw new Error('Expected markdown text block');
        }

        expect(blocks[0].content).toEqual([
            { styles: [], text: 'Visit ', url: null },
            { styles: [], text: 'https://example.com/docs', url: 'https://example.com/docs' },
            { styles: [], text: ' for more.', url: null },
        ]);
    });
});

describe('parseMarkdown tables', () => {
    it('parses a standard 3-column table with leading and trailing pipes', () => {
        const blocks = parseMarkdown([
            '| Name | Age | City |',
            '| --- | --- | --- |',
            '| Alice | 30 | NYC |',
            '| Bob | 25 | LA |',
        ].join('\n'));

        expect(blocks).toHaveLength(1);
        const table = blocks[0];
        expect(table?.type).toBe('table');
        if (table?.type  !== 'table') throw new Error('Expected table');

        expect(table.headers).toHaveLength(3);
        expect(table.rows).toHaveLength(2);
        expect(table.rows[0]).toHaveLength(3);
        expect(table.rows[1]).toHaveLength(3);
    });

    it('preserves empty cells instead of dropping them', () => {
        const blocks = parseMarkdown([
            '| A | B | C |',
            '| --- | --- | --- |',
            '| x |  | z |',
        ].join('\n'));

        expect(blocks).toHaveLength(1);
        const table = blocks[0];
        if (table?.type  !== 'table') throw new Error('Expected table');

        expect(table.headers).toHaveLength(3);
        expect(table.rows[0]).toHaveLength(3);
        // Middle cell should be empty spans array
        expect(table.rows[0][1]).toEqual([]);
    });

    it('parses tables without leading/trailing pipes', () => {
        const blocks = parseMarkdown([
            'A | B | C',
            '--- | --- | ---',
            'x | y | z',
        ].join('\n'));

        expect(blocks).toHaveLength(1);
        const table = blocks[0];
        if (table?.type  !== 'table') throw new Error('Expected table');

        expect(table.headers).toHaveLength(3);
        expect(table.rows).toHaveLength(1);
        expect(table.rows[0]).toHaveLength(3);
    });
});
