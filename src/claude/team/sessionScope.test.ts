import { describe, expect, it } from 'vitest';

import {
    buildSessionScope,
    buildSessionScopeFilters,
    matchesSessionScopeFilter,
} from './sessionScope';

describe('sessionScope', () => {
    it('builds scoped session identity from metadata path and worktree name', () => {
        const scope = buildSessionScope({
            path: '/Users/copizza/Desktop/happyhere/aha-cli-0330-max-redefine-login',
            runtimeBuild: {
                worktreeName: 'aha-cli-0330-max-redefine-login',
            },
        } as any);

        expect(scope).toEqual({
            scopePath: '/Users/copizza/Desktop/happyhere/aha-cli-0330-max-redefine-login',
            scopeLabel: 'aha-cli-0330-max-redefine-login',
            repoName: 'aha-cli',
            visibility: 'scoped',
        });
    });

    it('builds list filters that keep scoped and global messages visible', () => {
        expect(buildSessionScopeFilters({
            path: '/Users/copizza/Desktop/happyhere/kanban-0330-max-redefine-login',
            runtimeBuild: {
                worktreeName: 'kanban-0330-max-redefine-login',
            },
        } as any)).toEqual({
            scopePath: '/Users/copizza/Desktop/happyhere/kanban-0330-max-redefine-login',
            repoName: 'kanban',
            includeGlobal: true,
        });
    });

    it('matches exact scope paths and same-repo scoped messages', () => {
        const filters = {
            scopePath: '/Users/copizza/Desktop/happyhere/genome-hub-0330-max-redefine-login',
            repoName: 'genome-hub',
            includeGlobal: true,
        };

        expect(matchesSessionScopeFilter({
            scopePath: '/Users/copizza/Desktop/happyhere/genome-hub-0330-max-redefine-login',
            repoName: 'genome-hub',
            visibility: 'scoped',
        }, filters)).toBe(true);

        expect(matchesSessionScopeFilter({
            scopePath: '/Users/copizza/Desktop/happyhere/genome-hub-feature-x',
            repoName: 'genome-hub',
            visibility: 'scoped',
        }, filters)).toBe(true);
    });

    it('keeps global messages but rejects different scoped repos', () => {
        const filters = {
            scopePath: '/Users/copizza/Desktop/happyhere/happy-server-0330-max-redefine-login',
            repoName: 'happy-server',
            includeGlobal: true,
        };

        expect(matchesSessionScopeFilter({
            visibility: 'global',
        }, filters)).toBe(true);

        expect(matchesSessionScopeFilter({
            scopePath: '/Users/copizza/Desktop/happyhere/kanban-0330-max-redefine-login',
            repoName: 'kanban',
            visibility: 'scoped',
        }, filters)).toBe(false);
    });
});
